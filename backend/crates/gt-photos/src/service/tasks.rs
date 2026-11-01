//! Fire-and-forget tasks (Go `go func(){...}()`) that can still be awaited, so graceful
//! shutdown and tests can wait until spawned notification work has finished.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// Spawns detached tasks and counts the ones still running.
#[derive(Debug, Clone, Default)]
pub(crate) struct BackgroundTasks {
    inner: Arc<Counter>,
}

#[derive(Debug, Default)]
struct Counter {
    running: AtomicUsize,
    idle: Notify,
}

/// Decrements the counter when the task ends, however it ends (completion, panic, abort).
struct RunningGuard(Arc<Counter>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if self.0.running.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl BackgroundTasks {
    /// Runs `task` on the Tokio runtime without awaiting it.
    pub(crate) fn spawn<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner.running.fetch_add(1, Ordering::AcqRel);
        let guard = RunningGuard(self.inner.clone());
        tokio::spawn(async move {
            let _guard = guard;
            task.await;
        });
    }

    /// Resolves once no spawned task is running.
    pub(crate) async fn wait_idle(&self) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.running.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn waits_for_spawned_tasks() {
        let tasks = BackgroundTasks::default();
        tasks.wait_idle().await;

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let done = Arc::new(AtomicUsize::new(0));
        let flag = done.clone();
        tasks.spawn(async move {
            let _ = rx.await;
            flag.store(1, Ordering::SeqCst);
        });
        assert!(tokio::time::timeout(Duration::from_millis(20), tasks.wait_idle()).await.is_err());
        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), tasks.wait_idle()).await.unwrap();
        assert_eq!(done.load(Ordering::SeqCst), 1);
    }
}
