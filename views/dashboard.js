// Progressive enhancement for the dashboard. The pages are fully functional
// without this; it only adds auto-refresh while work is in flight and a
// token-gated "re-run build" action.
(() => {
  'use strict';

  // --- Auto-refresh while builds are queued/running ----------------------
  // The server adds <meta name="dashboard-refresh" content="N"> only when the
  // queue is non-empty, so static pages never poll.
  const refreshMeta = document.querySelector('meta[name="dashboard-refresh"]');
  if (refreshMeta) {
    const secs = Math.max(3, parseInt(refreshMeta.content, 10) || 5);
    let timer = null;
    const tick = () => { if (!document.hidden) location.reload(); };
    const arm = () => { timer = setTimeout(tick, secs * 1000); };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && timer) { clearTimeout(timer); timer = null; }
      else if (!document.hidden && !timer) arm();
    });
    arm();
  }

  // --- Toast helper ------------------------------------------------------
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, kind === 'err' ? 6000 : 3500);
  }

  // --- Re-run build (POST /api/builds/:id/rerun, bearer-authed) ----------
  // The dashboard's read views are token-free, but rerun mutates the queue and
  // needs the upload token — so we ask for it on demand and never store it.
  const rerunBtn = document.getElementById('rerun-btn');
  if (rerunBtn) {
    rerunBtn.addEventListener('click', async () => {
      const buildId = rerunBtn.dataset.build;
      const token = window.prompt('Upload token (Bearer) to re-run this build:');
      if (!token) return;
      rerunBtn.disabled = true;
      const original = rerunBtn.textContent;
      rerunBtn.textContent = 'Re-running…';
      try {
        const res = await fetch(`/api/builds/${buildId}/rerun`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token.trim()}` },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          toast(`Re-queued ${data.cells ?? ''} cell(s). Refreshing…`, 'ok');
          setTimeout(() => location.reload(), 1200);
        } else {
          toast(`Re-run failed: ${data.message || res.statusText}`, 'err');
          rerunBtn.disabled = false;
          rerunBtn.textContent = original;
        }
      } catch (err) {
        toast(`Re-run error: ${err.message}`, 'err');
        rerunBtn.disabled = false;
        rerunBtn.textContent = original;
      }
    });
  }
})();
