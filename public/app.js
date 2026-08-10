const TERMINAL = new Set(['completed', 'failed', 'paused']);

const state = {
  view: 'upload',
  runs: [],
  selectedId: null,
  pollTimer: null,
};

const els = {
  tabs: document.querySelectorAll('.tab'),
  views: {
    upload: document.getElementById('view-upload'),
    history: document.getElementById('view-history'),
    detail: document.getElementById('view-detail'),
  },
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  uploadStatus: document.getElementById('upload-status'),
  runsBody: document.getElementById('runs-body'),
  backBtn: document.getElementById('back-btn'),
  detailHeader: document.getElementById('detail-header'),
  detailDownloads: document.getElementById('detail-downloads'),
  logStream: document.getElementById('log-stream'),
};

function showView(name) {
  state.view = name;
  for (const [key, el] of Object.entries(els.views)) {
    el.classList.toggle('active', key === name);
  }
  els.tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === name);
  });
}

function formatTs(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusBadge(status) {
  const live = !TERMINAL.has(status);
  return `<span class="badge ${status || 'queued'}${live ? ' live' : ''}">${status || 'queued'}</span>`;
}

function renderRuns() {
  if (!state.runs.length) {
    els.runsBody.innerHTML = `<tr><td colspan="8" class="muted">No runs yet — upload a CSV to start.</td></tr>`;
    return;
  }

  els.runsBody.innerHTML = state.runs
    .map(
      (run) => `
      <tr data-id="${run.id}">
        <td>${escapeHtml(run.segment_name)}</td>
        <td>${statusBadge(run.status)}</td>
        <td>${run.total_emails ?? '—'}</td>
        <td>${run.final_sendable_count ?? '—'}</td>
        <td>${run.final_rejected_count ?? '—'}</td>
        <td>${run.mv_credits_used ?? 0}</td>
        <td>${run.n2b_credits_used ?? 0}</td>
        <td>${formatTs(run.created_at)}</td>
      </tr>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchRuns() {
  const res = await fetch('/api/runs');
  if (!res.ok) throw new Error('Failed to load runs');
  const data = await res.json();
  state.runs = data.runs || [];
  renderRuns();
  schedulePoll();
}

async function fetchDetail(id) {
  const res = await fetch(`/api/runs/${id}`);
  if (!res.ok) throw new Error('Failed to load run');
  const data = await res.json();
  const run = data.run;

  els.detailHeader.innerHTML = `
    <h2>${escapeHtml(run.segment_name)}</h2>
    <div class="detail-meta">
      ${statusBadge(run.status)}
      <span>${run.total_emails ?? 0} emails</span>
      <span>sendable ${run.final_sendable_count ?? 0}</span>
      <span>rejected ${run.final_rejected_count ?? 0}</span>
      <span>MV ${run.mv_credits_used ?? 0} · N2B ${run.n2b_credits_used ?? 0}</span>
      ${run.mv_ok_count != null ? `<span>ok ${run.mv_ok_count} · catch_all ${run.mv_catch_all_count ?? 0} · unknown ${run.mv_unknown_count ?? 0} · invalid ${run.mv_invalid_count ?? 0}</span>` : ''}
      ${run.stage_completed ? `<span>stage ${escapeHtml(run.stage_completed)}</span>` : ''}
      <span>created ${formatTs(run.created_at)}</span>
      ${run.completed_at ? `<span>completed ${formatTs(run.completed_at)}</span>` : ''}
    </div>
    ${
      run.last_error || run.error_message
        ? `<p class="muted">${escapeHtml(run.last_error || run.error_message)}</p>`
        : ''
    }
    ${
      ['failed', 'paused'].includes(run.status)
        ? `<p><button type="button" id="resume-btn" data-id="${run.id}">Resume from last stage</button></p>`
        : ''
    }
  `;

  const resumeBtn = document.getElementById('resume-btn');
  if (resumeBtn) {
    resumeBtn.onclick = async () => {
      resumeBtn.disabled = true;
      try {
        const r = await fetch(`/api/runs/${run.id}/resume`, { method: 'POST' });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || 'Resume failed');
        await fetchDetail(run.id);
      } catch (err) {
        alert(err.message);
        resumeBtn.disabled = false;
      }
    };
  }

  if (data.downloads) {
    els.detailDownloads.hidden = false;
    els.detailDownloads.innerHTML = `
      <a href="${data.downloads.sendable_url}" target="_blank" rel="noopener">Download SENDABLE CSV</a>
      <a href="${data.downloads.rejected_url}" target="_blank" rel="noopener">Download REJECTED CSV</a>
    `;
  } else {
    els.detailDownloads.hidden = true;
    els.detailDownloads.innerHTML = '';
  }

  const logs = data.logs || [];
  els.logStream.textContent = logs.length
    ? logs.map((l) => `[${formatTs(l.created_at)}] ${l.message}`).join('\n')
    : 'No log entries yet.';
  els.logStream.scrollTop = els.logStream.scrollHeight;

  // Keep detail in sync while non-terminal
  if (!TERMINAL.has(run.status)) {
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const needsPoll =
    state.runs.some((r) => !TERMINAL.has(r.status)) ||
    (state.view === 'detail' && state.selectedId);

  if (!needsPoll) return;

  state.pollTimer = setTimeout(async () => {
    try {
      if (state.view === 'history' || state.view === 'detail') {
        await fetchRuns();
      }
      if (state.view === 'detail' && state.selectedId) {
        await fetchDetail(state.selectedId);
      }
    } catch (err) {
      console.error(err);
      schedulePoll();
    }
  }, 5000);
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => f.name.toLowerCase().endsWith('.csv'));
  if (!files.length) {
    els.uploadStatus.hidden = false;
    els.uploadStatus.textContent = 'Please select CSV files.';
    return;
  }

  const form = new FormData();
  for (const file of files) form.append('files', file);

  els.uploadStatus.hidden = false;
  els.uploadStatus.textContent = `Uploading ${files.length} file(s)…`;

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    els.uploadStatus.textContent = `Upload failed: ${data.error || res.statusText}`;
    return;
  }

  const lines = (data.runs || []).map(
    (r) => `✓ ${r.segment_name} → ${r.run_id} (${r.total_emails} emails, ${r.status})`
  );
  els.uploadStatus.textContent = `Queued:\n${lines.join('\n')}`;
  await fetchRuns();
  showView('history');
}

// Events
els.tabs.forEach((tab) => {
  tab.addEventListener('click', async () => {
    const view = tab.dataset.view;
    if (view === 'history') {
      showView('history');
      await fetchRuns();
    } else if (view === 'upload') {
      showView('upload');
    }
  });
});

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) uploadFiles(els.fileInput.files);
});

['dragenter', 'dragover'].forEach((evt) => {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragover');
  });
});
els.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

els.runsBody.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  state.selectedId = row.dataset.id;
  showView('detail');
  await fetchDetail(state.selectedId);
});

els.backBtn.addEventListener('click', async () => {
  state.selectedId = null;
  showView('history');
  await fetchRuns();
});

fetchRuns().catch((err) => {
  console.error(err);
  els.runsBody.innerHTML = `<tr><td colspan="8" class="muted">Could not load runs: ${escapeHtml(err.message)}</td></tr>`;
});
