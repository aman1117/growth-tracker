//! Token bucket with the semantics of `golang.org/x/time/rate.Limiter` as the Go worker uses it:
//! `rate.NewLimiter(rate.Limit(n), n)` (n tokens per second, burst n, initially full) and
//! `Wait(ctx)`.

use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

/// Why [`RateLimiter::wait`] gave up; messages follow `x/time/rate`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RateLimitError {
    /// The limit is not positive, so no token can ever be granted.
    #[error("rate: Wait(n=1) exceeds limiter's burst {0}")]
    ExceedsBurst(i64),
    /// The worker is shutting down.
    #[error("context canceled")]
    Cancelled,
}

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// Grants `rate` events per second with bursts of up to `rate`.
#[derive(Debug)]
pub struct RateLimiter {
    rate: i64,
    bucket: Mutex<Bucket>,
}

impl RateLimiter {
    pub fn new(rate: i64) -> Self {
        Self { rate, bucket: Mutex::new(Bucket { tokens: rate.max(0) as f64, last: Instant::now() }) }
    }

    /// Reserves a token and returns how long to wait before using it.
    fn reserve(&self) -> Duration {
        let rate = self.rate as f64;
        let mut bucket = self.bucket.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate).min(rate);
        bucket.last = now;
        bucket.tokens -= 1.0;
        if bucket.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-bucket.tokens / rate)
        }
    }

    fn cancel_reservation(&self) {
        let mut bucket = self.bucket.lock().unwrap_or_else(|e| e.into_inner());
        bucket.tokens = (bucket.tokens + 1.0).min(self.rate as f64);
    }

    /// Waits for a token; fails at once when `stop` is already set or the limit is not positive,
    /// and gives the token back when `stop` is set while waiting.
    pub async fn wait(&self, stop: &mut watch::Receiver<bool>) -> Result<(), RateLimitError> {
        if self.rate <= 0 {
            return Err(RateLimitError::ExceedsBurst(self.rate));
        }
        if *stop.borrow() {
            return Err(RateLimitError::Cancelled);
        }
        let delay = self.reserve();
        if delay.is_zero() {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => Ok(()),
            stopped = async { stop.wait_for(|stopped| *stopped).await.is_ok() } => {
                if stopped {
                    self.cancel_reservation();
                    Err(RateLimitError::Cancelled)
                } else {
                    // The stop signal can no longer fire: wait out the delay.
                    tokio::time::sleep(delay).await;
                    Ok(())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bursts_then_paces() {
        let limiter = RateLimiter::new(2);
        let (_tx, mut stop) = watch::channel(false);
        let start = Instant::now();
        for _ in 0..2 {
            limiter.wait(&mut stop).await.unwrap();
        }
        assert_eq!(start.elapsed(), Duration::ZERO);
        limiter.wait(&mut stop).await.unwrap();
        assert!(start.elapsed() >= Duration::from_millis(499), "{:?}", start.elapsed());
        limiter.wait(&mut stop).await.unwrap();
        assert!(start.elapsed() >= Duration::from_millis(999), "{:?}", start.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn non_positive_limits_and_cancellation() {
        let (tx, mut stop) = watch::channel(false);
        assert_eq!(
            RateLimiter::new(0).wait(&mut stop).await.unwrap_err().to_string(),
            "rate: Wait(n=1) exceeds limiter's burst 0"
        );
        assert_eq!(RateLimiter::new(-3).wait(&mut stop).await.unwrap_err(), RateLimitError::ExceedsBurst(-3));

        let limiter = std::sync::Arc::new(RateLimiter::new(1));
        limiter.wait(&mut stop).await.unwrap();
        let waiting = {
            let limiter = limiter.clone();
            let mut stop = stop.clone();
            tokio::spawn(async move { limiter.wait(&mut stop).await })
        };
        tokio::task::yield_now().await;
        tx.send_replace(true);
        assert_eq!(waiting.await.unwrap().unwrap_err().to_string(), "context canceled");
        assert_eq!(limiter.wait(&mut stop).await.unwrap_err(), RateLimitError::Cancelled);
    }
}
