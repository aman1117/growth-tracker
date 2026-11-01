//! Structured logging (port of `internal/logger`).
//!
//! * production: one JSON object per line on stdout (`timestamp`, `level`, `message` plus
//!   fields of the event and its spans, e.g. `trace_id`), also shipped to Axiom when
//!   `AXIOM_DATASET` and `AXIOM_API_TOKEN` are set (batched every 2 s);
//! * development: human-readable console output.
//!
//! The level filter comes from `RUST_LOG` (default `info`). Never log secrets or PII such as
//! passwords, tokens or email bodies.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::config::Config;

const APP_NAME: &str = "growth-tracker";

/// Handle returned by [`init`]; call [`LogHandle::flush`] before exiting to ship buffered
/// Axiom entries.
#[derive(Clone, Default)]
pub struct LogHandle {
    axiom: Option<Arc<AxiomSink>>,
}

impl LogHandle {
    pub async fn flush(&self) {
        if let Some(axiom) = &self.axiom {
            axiom.flush().await;
        }
    }
}

/// Installs the global subscriber. Safe to call once per process; later calls are ignored.
pub fn init(cfg: &Config) -> LogHandle {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if cfg.is_production() {
        let axiom = (!cfg.axiom.dataset.is_empty() && !cfg.axiom.api_token.is_empty())
            .then(|| AxiomSink::start(&cfg.axiom.dataset, &cfg.axiom.api_token, &cfg.env));
        let layer = JsonLayer { axiom: axiom.clone() };
        let _ = tracing_subscriber::registry().with(filter).with(layer).try_init();
        LogHandle { axiom }
    } else {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_target(false).compact())
            .try_init();
        LogHandle::default()
    }
}

/// Installs a console subscriber for CLI tools and tests.
pub fn init_console() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false).compact())
        .try_init();
}

/// Fields recorded on a span, merged into every event inside it.
struct SpanFields(Map<String, Value>);

struct JsonVisitor<'a>(&'a mut Map<String, Value>);

impl Visit for JsonVisitor<'_> {
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.0.insert(field.name().to_string(), Value::from(value.to_string()));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().to_string(), Value::from(format!("{value:?}")));
    }
}

struct JsonLayer {
    axiom: Option<Arc<AxiomSink>>,
}

impl<S> Layer<S> for JsonLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, id: &tracing::span::Id, ctx: Context<'_, S>) {
        let mut fields = Map::new();
        attrs.record(&mut JsonVisitor(&mut fields));
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanFields(fields));
        }
    }

    fn on_record(&self, id: &tracing::span::Id, values: &tracing::span::Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut ext = span.extensions_mut();
            if let Some(SpanFields(fields)) = ext.get_mut::<SpanFields>() {
                values.record(&mut JsonVisitor(fields));
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut entry = Map::new();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(SpanFields(fields)) = span.extensions().get::<SpanFields>() {
                    entry.extend(fields.clone());
                }
            }
        }
        let mut fields = Map::new();
        event.record(&mut JsonVisitor(&mut fields));
        let message = fields.remove("message").unwrap_or(Value::from(""));
        entry.extend(fields);
        entry.insert("level".into(), Value::from(event.metadata().level().as_str().to_lowercase()));
        entry.insert("timestamp".into(), Value::from(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()));
        entry.insert("message".into(), message);

        let line = Value::Object(entry);
        {
            let stdout = std::io::stdout();
            let mut lock = stdout.lock();
            let _ = serde_json::to_writer(&mut lock, &line);
            let _ = lock.write_all(b"\n");
        }
        if let Some(axiom) = &self.axiom {
            axiom.push(line);
        }
    }
}

/// Buffers log entries and ships them to Axiom's ingest API.
struct AxiomSink {
    url: String,
    token: String,
    env: String,
    buffer: Mutex<Vec<Value>>,
    client: reqwest::Client,
}

impl AxiomSink {
    fn start(dataset: &str, token: &str, env: &str) -> Arc<Self> {
        let sink = Arc::new(Self {
            url: format!("https://api.axiom.co/v1/datasets/{dataset}/ingest"),
            token: token.to_string(),
            env: env.to_string(),
            buffer: Mutex::new(Vec::with_capacity(100)),
            client: reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default(),
        });
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&sink);
            rt.spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(2));
                loop {
                    ticker.tick().await;
                    match weak.upgrade() {
                        Some(sink) => sink.flush().await,
                        None => return,
                    }
                }
            });
        }
        sink
    }

    fn push(&self, mut entry: Value) {
        if let Value::Object(map) = &mut entry {
            map.insert(
                "_time".into(),
                Value::from(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)),
            );
            map.insert("app".into(), Value::from(APP_NAME));
            map.insert("env".into(), Value::from(self.env.clone()));
        }
        self.buffer.lock().unwrap_or_else(|e| e.into_inner()).push(entry);
    }

    async fn flush(&self) {
        let entries = std::mem::take(&mut *self.buffer.lock().unwrap_or_else(|e| e.into_inner()));
        if entries.is_empty() {
            return;
        }
        // Best effort: a failed shipment must never affect request handling.
        let _ = self.client.post(&self.url).bearer_auth(&self.token).json(&entries).send().await;
    }
}
