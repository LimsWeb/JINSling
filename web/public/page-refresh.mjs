// Poll only while a page is visible and online. A slow request is never overlapped.
export function startVisibleRefresh({
  refresh, onError = () => {}, intervalMs = 30_000,
  documentTarget = document, windowTarget = window,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer, inFlight = null, stopped = false;
  const canRun = () => !stopped && documentTarget.visibilityState !== 'hidden' && windowTarget.navigator?.onLine !== false;
  const unschedule = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = () => {
    unschedule();
    if (canRun()) timer = setTimer(run, intervalMs);
  };
  function run() {
    if (inFlight) return inFlight;
    if (!canRun()) return Promise.resolve();
    unschedule();
    inFlight = Promise.resolve().then(refresh).catch(onError).finally(() => {
      inFlight = null;
      schedule();
    });
    return inFlight;
  }
  const resume = () => { if (canRun()) void run(); else unschedule(); };
  const pause = () => unschedule();
  documentTarget.addEventListener('visibilitychange', resume);
  windowTarget.addEventListener('focus', resume);
  windowTarget.addEventListener('online', resume);
  windowTarget.addEventListener('offline', pause);
  schedule();
  return {
    run,
    stop() {
      stopped = true;
      unschedule();
      documentTarget.removeEventListener('visibilitychange', resume);
      windowTarget.removeEventListener('focus', resume);
      windowTarget.removeEventListener('online', resume);
      windowTarget.removeEventListener('offline', pause);
    },
  };
}

export function sessionAccessKey(session) {
  const user = session?.user;
  return JSON.stringify([
    Boolean(session?.configured), Boolean(session?.auth_ready),
    user?.id ?? null, user?.role ?? null, user?.status ?? null,
    Boolean(user?.needs_password_setup), Boolean(user?.password_reset_required),
  ]);
}
