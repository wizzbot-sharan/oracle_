import { useEffect, useMemo, useState } from 'react';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function visibleWhen(condition, answers) {
  if (!condition) return true;
  if (condition.all) return condition.all.every(item => visibleWhen(item, answers));
  const val = answers[condition.field];
  if (condition.includes !== undefined) {
    return Array.isArray(val) ? val.includes(condition.includes) : val === condition.includes;
  }
  return val === condition.equals;
}

function Field({ field, value, onChange, answers, fieldAudit }) {
  const effectiveCondition = field.visibleWhen || (field.isConditional && field.triggerFieldId ? {
    field: field.triggerFieldId,
    [field.conditionType === 'includes' ? 'includes' : 'equals']: field.triggerValue
  } : null);
  if (!visibleWhen(effectiveCondition, answers)) return null;
  const required = field.required ? <span className="required">*</span> : null;

  const isResolved = fieldAudit && fieldAudit.value !== null && fieldAudit.value !== '' && (fieldAudit.confidence ?? 0) >= 0.80;
  const sourceName = fieldAudit?.source ? fieldAudit.source.replace(/^tier\d+_/, '').replace(/_/g, ' ') : '';
  const confidencePercent = fieldAudit?.confidence ? `${Math.round(fieldAudit.confidence * 100)}%` : '';
  const badgeText = isResolved
    ? `Resolved${confidencePercent ? ` (${sourceName ? `${sourceName}, ` : ''}${confidencePercent})` : ''}`
    : 'Unresolved';

  const header = (
    <div className="field-header">
      <span className="field-label">
        {field.isConditional && <span className="conditional-marker" title="Conditional Question">↳ </span>}
        {field.label} {required}
      </span>
      <div className="field-header-badges">
        {field.isConditional && (
          <span className="conditional-tag" title={`Revealed when "${field.triggerLabel || field.triggerFieldId}" = "${field.triggerValue}"`}>
            Conditional ({field.triggerValue})
          </span>
        )}
        <span
          className={`audit-badge ${isResolved ? 'resolved' : 'unresolved'}`}
          title={isResolved ? `Source: ${fieldAudit?.source || 'N/A'}` : 'Requires operator input'}
        >
          <span className={`audit-dot ${isResolved ? 'green' : 'red'}`} />
          {badgeText}
        </span>
      </div>
    </div>
  );

  const fieldClass = `field ${field.isConditional ? 'conditional-field' : ''}`;

  if (field.type === 'compound-phone') {
    return (
      <fieldset className={fieldClass}>
        {header}
        {field.children.map(child => (
          <Field
            key={child.id}
            field={child}
            value={answers[child.id]}
            answers={answers}
            fieldAudit={fieldAudit}
            onChange={onChange}
          />
        ))}
      </fieldset>
    );
  }

  if (field.type === 'repeatable-group') {
    return <RepeatableGroup field={field} value={value} onChange={next => onChange(field.id, next)} />;
  }

  if (field.type === 'radio') {
    return (
      <fieldset className={fieldClass}>
        {header}
        <div className="choices">
          {(field.options ?? []).map(option => (
            <label key={option} className="choice">
              <input
                type="radio"
                name={field.id}
                checked={value === option}
                onChange={() => onChange(field.id, option)}
              />{' '}
              {option}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <div className={fieldClass}>
        {header}
        <label className="choice">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={event => onChange(field.id, event.target.checked)}
          />{' '}
          {field.label}
        </label>
      </div>
    );
  }

  if (field.type === 'multi-checkbox') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className={fieldClass}>
        {header}
        <div className="choices">
          {(field.options ?? []).map(option => (
            <label key={option} className="choice">
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={event =>
                  onChange(
                    field.id,
                    event.target.checked ? [...selected, option] : selected.filter(item => item !== option)
                  )
                }
              />{' '}
              {option}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.type === 'month-year') {
    const date = value && typeof value === 'object' ? value : { month: '', year: '' };
    return (
      <div className={fieldClass}>
        {header}
        <div className="date-row">
          <input
            aria-label={`${field.label} month`}
            placeholder="Month"
            value={date.month ?? ''}
            onChange={event => onChange(field.id, { ...date, month: event.target.value })}
          />
          <input
            aria-label={`${field.label} year`}
            placeholder="Year"
            value={date.year ?? ''}
            onChange={event => onChange(field.id, { ...date, year: event.target.value })}
          />
        </div>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className={fieldClass}>
        {header}
        <textarea value={value ?? ''} onChange={event => onChange(field.id, event.target.value)} />
      </div>
    );
  }

  const inputType = field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text';
  return (
    <div className={fieldClass}>
      {header}
      <input
        type={inputType}
        value={value ?? ''}
        placeholder={field.type === 'combobox' ? 'Search or enter a value' : ''}
        onChange={event => onChange(field.id, event.target.value)}
      />
    </div>
  );
}

function RepeatableGroup({ field, value, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const childFields = field.children ?? field.fields ?? [];
  const setRow = (index, childId, childValue) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [childId]: childValue } : row)));

  return (
    <fieldset className="repeatable">
      <legend>{field.label}</legend>
      {rows.map((row, index) => (
        <div className="repeat-row" key={index}>
          <div className="repeat-header">
            <strong>
              {field.label} {index + 1}
            </strong>
            <button
              className="secondary danger"
              type="button"
              onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
            >
              Remove
            </button>
          </div>
          {childFields.map(child => (
            <Field
              key={child.id}
              field={child}
              value={row[child.id]}
              answers={row}
              onChange={(id, next) => setRow(index, id, next)}
            />
          ))}
        </div>
      ))}
      <button className="secondary" type="button" onClick={() => onChange([...rows, {}])}>
        + {field.addButton ?? `Add ${field.label}`}
      </button>
    </fieldset>
  );
}

function TemplateForm({ template, application, onSaved }) {
  const initial = useMemo(
    () => Object.fromEntries(Object.entries(application.values ?? {}).map(([id, item]) => [id, item.value])),
    [application]
  );
  const [answers, setAnswers] = useState(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => setAnswers(initial), [initial]);
  const update = (id, value) => setAnswers(current => ({ ...current, [id]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const changed = Object.fromEntries(
        Object.entries(answers).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(initial[id]))
      );
      await api(`/api/applications/${application.applicationId}/answers`, {
        method: 'PUT',
        body: JSON.stringify({ updates: changed })
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const sections =
    template.sections ??
    (() => {
      const grouped = new Map();
      for (const field of template.fields ?? []) {
        const label = field.sectionLabel ?? 'Application fields';
        const section = grouped.get(label) ?? {
          id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          label,
          fields: []
        };
        section.fields.push(field);
        grouped.set(label, section);
      }
      const result = [...grouped.values()];
      if (template.repeatableGroups?.length) {
        result.push({
          id: 'repeatable_groups',
          label: 'Work, education and links',
          groups: template.repeatableGroups
        });
      }
      return result;
    })();

  return (
    <div className="form-stack">
      {sections.map(section => (
        <section className="form-section" key={section.id}>
          <h2>{section.label}</h2>
          {(section.fields ?? []).map(field => (
            <Field
              key={field.id}
              field={field}
              value={answers[field.id]}
              answers={answers}
              fieldAudit={application.values?.[field.id]}
              onChange={update}
            />
          ))}
          {(section.groups ?? []).map(group => (
            <RepeatableGroup
              key={group.id}
              field={{
                ...group,
                children: group.children ?? group.fields ?? [],
                label: group.label ?? group.id.replaceAll('_', ' ')
              }}
              value={answers[group.id]}
              onChange={next => update(group.id, next)}
            />
          ))}
        </section>
      ))}
      <div className="sticky-actions">
        <button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save answers'}
        </button>
      </div>
    </div>
  );
}

function ExecutiveMetrics({ metrics }) {
  if (!metrics) return null;

  return (
    <div className="metrics-scroll">
      <div className="metric-card">
        <div className="metric-title">Total Clients</div>
        <div className="metric-value">{metrics.totalClients ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Total Jobs</div>
        <div className="metric-value">{metrics.totalJobs ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Unique URLs</div>
        <div className="metric-value">{metrics.uniqueUrls ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Scanned Requisitions</div>
        <div className="metric-value">{metrics.scannedUrls ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Unlockable Applications</div>
        <div className="metric-value">{metrics.unlockableApplications ?? 0}</div>
        <div className="metric-subbadge">covered by scans</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Pre-AI Resolved</div>
        <div className="metric-value">{metrics.resolvedPreAiApps ?? 0} Apps</div>
        <div className="metric-subbadge">{metrics.resolvedPreAiQuestions ?? 0} Questions</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">AI Resolved</div>
        <div className="metric-value">{metrics.resolvedWithAiApps ?? 0} Apps</div>
        <div className="metric-subbadge">{metrics.resolvedWithAiQuestions ?? 0} Questions</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Dashboard Review</div>
        <div className="metric-value">{metrics.dashboardReviewApps ?? 0} Apps</div>
        <div className="metric-subbadge">{metrics.dashboardReviewQuestions ?? 0} Questions</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Ready To Apply</div>
        <div className="metric-value">{metrics.readyToApply ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Prepared (Filled)</div>
        <div className="metric-value">{metrics.prepared ?? 0}</div>
      </div>
      <div className="metric-card">
        <div className="metric-title">Submitted</div>
        <div className="metric-value">{metrics.submitted ?? 0}</div>
      </div>
    </div>
  );
}

function WorkerPoolWidget({ status }) {
  if (!status) return null;
  const { slots = [], pendingQueueLength = 0 } = status;

  const getBadgeClass = (s) => {
    if (s === 'awaiting_review') return 'awaiting_review';
    if (s === 'filling') return 'filling';
    if (s === 'launching') return 'launching';
    if (s === 'submitting') return 'submitting';
    if (s === 'cooldown') return 'cooldown';
    return 'idle';
  };

  const formatStatus = (s, cooldownRemainingMs) => {
    if (s === 'awaiting_review') return 'Awaiting Review';
    if (s === 'filling') return 'Filling Form...';
    if (s === 'launching') return 'Launching (30s throttle)';
    if (s === 'submitting') return 'Submitting (10s settle)';
    if (s === 'cooldown') return `Cooldown (${Math.ceil((cooldownRemainingMs || 10000) / 1000)}s)`;
    return 'Idle';
  };

  return (
    <div className="worker-pool">
      <div className="worker-pool-header">
        <div className="worker-pool-title">
          <span>Live 3-Browser Submission Workers</span>
        </div>
        <div className={`queue-pill ${pendingQueueLength > 0 ? 'has-pending' : ''}`}>
          Pending Queue: <strong>{pendingQueueLength}</strong> {pendingQueueLength === 1 ? 'application' : 'applications'}
        </div>
      </div>
      <div className="worker-slots-grid">
        {slots.map(slot => (
          <div key={slot.slotId} className={`worker-slot ${slot.status !== 'idle' ? 'active' : ''} ${slot.status === 'awaiting_review' ? 'awaiting_review' : ''}`}>
            <div className="slot-top">
              <span>Worker {slot.slotId}</span>
              <span className={`slot-badge ${getBadgeClass(slot.status)}`}>
                {formatStatus(slot.status, slot.cooldownRemainingMs)}
              </span>
            </div>
            {slot.status !== 'idle' && slot.status !== 'cooldown' && (
              <>
                <div className="slot-candidate" title={slot.clientName}>
                  {slot.clientName || slot.applywizzId}
                </div>
                <div className="slot-details">
                  <span>{slot.applywizzId}</span>
                  <span>•</span>
                  <span>Job {slot.jobKey}</span>
                </div>
              </>
            )}
            {slot.status === 'idle' && (
              <div className="slot-details" style={{ color: '#909e98' }}>Ready for next application</div>
            )}
            {slot.status === 'cooldown' && (
              <div className="slot-details" style={{ color: '#00695c' }}>Cooldown ({Math.ceil((slot.cooldownRemainingMs || 10000) / 1000)}s)</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterBar({ clients = [], assignments = [], selectedClientId, selectedJobKey, onClientChange, onJobChange }) {
  const assignedJobs = useMemo(() => {
    if (!selectedClientId) return [];
    return assignments.filter(a => (a.applywizzId || a.userId) === selectedClientId);
  }, [assignments, selectedClientId]);

  return (
    <div className="filter-bar">
      <div className="filter-group">
        <label>Candidate (Client)</label>
        <select value={selectedClientId ?? ''} onChange={e => onClientChange(e.target.value)}>
          <option value="">Select Candidate...</option>
          {clients.map(c => (
            <option key={c.applywizzId} value={c.applywizzId}>
              {c.clientName} ({c.applywizzId})
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label>Job Requisition</label>
        <select
          value={selectedJobKey ?? ''}
          onChange={e => onJobChange(e.target.value)}
          disabled={!selectedClientId || assignedJobs.length === 0}
        >
          <option value="">
            {assignedJobs.length === 0 ? 'No jobs assigned' : 'Select Assigned Job...'}
          </option>
          {assignedJobs.map(j => (
            <option key={j.assignmentId || `${j.jobKey}-${j.jobId}`} value={j.jobKey || j.jobId}>
              {j.jobKey ? `${j.jobKey}: ` : ''}{j.companyName || 'Company'} ({j.jobId})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedJobKey, setSelectedJobKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submissionStatus, setSubmissionStatus] = useState(null);

  const refresh = async () => {
    const next = await api('/api/dashboard');
    setData(next);
    if (next.submissionStatus) setSubmissionStatus(next.submissionStatus);
  };

  useEffect(() => {
    refresh().catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await api('/api/submission/status');
        setSubmissionStatus(status);
      } catch {}
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Sync selected application when data loads or selection changes
  useEffect(() => {
    if (!data?.applications?.length) return;

    if (!selectedId && !selectedClientId) {
      const first = data.applications[0];
      setSelectedId(first.applicationId);
      setSelectedClientId(first.userId || first.applywizzId || '');
      setSelectedJobKey(first.jobKey || first.jobId || '');
    }
  }, [data]);

  const handleClientChange = (newClientId) => {
    setSelectedClientId(newClientId);
    if (!data) return;

    const assignedJobs = (data.jobs?.assignments || []).filter(
      a => (a.applywizzId || a.userId) === newClientId
    );
    const firstJobKey = assignedJobs[0]?.jobKey || assignedJobs[0]?.jobId || '';
    setSelectedJobKey(firstJobKey);

    const matchingApp = data.applications.find(
      a =>
        (a.userId === newClientId || a.applywizzId === newClientId) &&
        (a.jobKey === firstJobKey || a.jobId === firstJobKey)
    );
    setSelectedId(matchingApp?.applicationId || null);
  };

  const handleJobChange = (newJobKey) => {
    setSelectedJobKey(newJobKey);
    if (!data) return;

    const matchingApp = data.applications.find(
      a =>
        (a.userId === selectedClientId || a.applywizzId === selectedClientId) &&
        (a.jobKey === newJobKey || a.jobId === newJobKey)
    );
    setSelectedId(matchingApp?.applicationId || null);
  };

  const handleCardClick = (application) => {
    setSelectedId(application.applicationId);
    setSelectedClientId(application.userId || application.applywizzId || '');
    setSelectedJobKey(application.jobKey || application.jobId || '');
  };

  const run = async (label, fn) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  if (!data) return <main className="loading">Loading workflow…</main>;

  const selected = data.applications.find(item => item.applicationId === selectedId);
  const template = selected ? (data.templates[selected.jobKey] || data.templates[selected.jobId]) : null;

  return (
    <div className="app-shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">AW</span>
          <div>
            <strong>Apply Workflow</strong>
            <small>Oracle Recruiting Cloud</small>
          </div>
        </div>
        <button
          className="secondary full"
          onClick={() => run('Seeding', () => api('/api/seed', { method: 'POST', body: '{}' }))}
        >
          Load reconnaissance sample
        </button>
        <nav>
          {data.applications.map(application => (
            <button
              key={application.applicationId}
              className={`application-card ${selectedId === application.applicationId ? 'active' : ''}`}
              onClick={() => handleCardClick(application)}
            >
              <span>{application.jobKey || `Job ${application.jobId}`}</span>
              <small>{application.clientName ? `${application.clientName} (${application.userId})` : application.userId}</small>
              <em data-status={application.status}>{application.status.replaceAll('_', ' ')}</em>
            </button>
          ))}
        </nav>
      </aside>

      <main>
        {/* Executive Metrics Overview Strip */}
        <ExecutiveMetrics metrics={data.metrics} />

        {/* 3-Browser Concurrency Worker Pool Widget */}
        <WorkerPoolWidget status={submissionStatus} />

        {/* Cascading Dropdown Filter Bar */}
        <FilterBar
          clients={data.clients || []}
          assignments={data.jobs?.assignments || []}
          selectedClientId={selectedClientId}
          selectedJobKey={selectedJobKey}
          onClientChange={handleClientChange}
          onJobChange={handleJobChange}
        />

        <header>
          <div>
            <p className="eyebrow">Application review</p>
            <h1>
              {selected
                ? `${selected.jobKey || `Job ${selected.jobId}`} - ${selected.clientName || selected.userId}`
                : 'Select an application'}
            </h1>
          </div>
          <div className="status">{busy || selected?.status || 'No selection'}</div>
        </header>

        {error && <div className="error">{error}</div>}

        {!selected && (
          <div className="empty">
            <h2>Application Not Yet Generated</h2>
            <p>
              An application instance for this candidate and job has not been generated yet. Run{' '}
              <code>npm run resolve:answers</code> to generate pre-computed application records.
            </p>
          </div>
        )}

        {selected && !template && (
          <div className="empty">
            <h2>Form Template Not Scanned</h2>
            <p>
              The form for requisition <strong>{selected.jobKey || selected.jobId}</strong> has not been scanned yet. Run the scanner queue to extract form fields.
            </p>
          </div>
        )}

        {selected && template && (() => {
          const activeSlot = submissionStatus?.slots?.find(s => s.applicationId === selected.applicationId && s.status !== 'idle');
          const isQueued = submissionStatus?.pendingQueue?.includes(selected.applicationId);
          const expectedJobId = selected.jobKey || selected.jobId;

          let applyButtonText = 'Apply (Start Live Fill)';
          let applyDisabled = false;

          if (selected.status === 'submitted') {
            applyButtonText = '✓ Application Submitted';
            applyDisabled = true;
          } else if (activeSlot) {
            if (activeSlot.status === 'launching') applyButtonText = `Worker ${activeSlot.slotId}: Launching Browser...`;
            else if (activeSlot.status === 'filling') applyButtonText = `Worker ${activeSlot.slotId}: Filling Form...`;
            else if (activeSlot.status === 'awaiting_review') applyButtonText = `Worker ${activeSlot.slotId}: Awaiting Review`;
            else if (activeSlot.status === 'submitting') applyButtonText = `Worker ${activeSlot.slotId}: Submitting...`;
            else if (activeSlot.status === 'cooldown') applyButtonText = `Worker ${activeSlot.slotId}: Cooldown`;
            applyDisabled = true;
          } else if (isQueued) {
            applyButtonText = 'Queued in Submission Pool...';
            applyDisabled = true;
          } else if (selected.status === 'needs_input') {
            applyButtonText = 'Resolve Questions Before Applying';
            applyDisabled = true;
          }

          const canSubmit = (selected.status === 'needs_review' || selected.reviewStatus === 'approved' || activeSlot?.status === 'awaiting_review') &&
            (confirmation === expectedJobId || confirmation === selected.jobId);

          return (
            <>
              <div className="workflow-bar">
                <span className="done">Ingested</span>
                <span className="done">Scanned</span>
                <span className={selected.status !== 'needs_input' ? 'done' : ''}>Answers</span>
                <span
                  className={
                    selected.status === 'needs_review' ||
                    selected.status === 'approved' ||
                    selected.status === 'submitted'
                      ? 'done'
                      : ''
                  }
                >
                  Review
                </span>
                <span className={selected.status === 'submitted' ? 'done' : ''}>Submitted</span>
              </div>

              <TemplateForm template={template} application={selected} onSaved={refresh} />

              <section className="apply-panel">
                <h2>Live Submission Engine (Max 3 Browsers)</h2>
                <p>
                  Authenticates with real candidate <strong>company_email</strong>, attaches cached resume, fills multi-page form, and halts at final review.
                </p>

                {selected.receipt && (
                  <div className="receipt-banner">
                    <strong>✓ Application Successfully Submitted</strong>
                    <div>Receipt Screenshot: <span className="receipt-path">{selected.receipt.filename || selected.receipt.screenshotPath}</span></div>
                    <div>Submitted At: {selected.receipt.submittedAt}</div>
                    {selected.receipt.source && <div>Method: {selected.receipt.source === 'site_manual' ? 'Direct Site Click' : 'Dashboard Approval'}</div>}
                  </div>
                )}

                <div className="action-row" style={{ marginTop: '14px' }}>
                  <button
                    disabled={applyDisabled}
                    onClick={() =>
                      run('Enqueueing application…', () =>
                        api(`/api/applications/${selected.applicationId}/prepare`, {
                          method: 'POST',
                          body: '{}'
                        })
                      )
                    }
                  >
                    {applyButtonText}
                  </button>
                  {selected.status === 'needs_review' && (
                    <button
                      className="secondary"
                      onClick={() =>
                        run('Approving…', () =>
                          api(`/api/applications/${selected.applicationId}/approve`, {
                            method: 'POST',
                            body: '{}'
                          })
                        )
                      }
                    >
                      Approve review
                    </button>
                  )}
                </div>

                {selected.status !== 'submitted' && (
                  <div className="submit-gate">
                    <label>
                      Type job ID <strong>{expectedJobId}</strong> to submit
                      <input
                        placeholder={`Type ${expectedJobId}`}
                        value={confirmation}
                        onChange={event => setConfirmation(event.target.value)}
                      />
                    </label>
                    <button
                      className="danger"
                      disabled={!canSubmit}
                      onClick={() =>
                        run('Submitting…', () =>
                          api(`/api/applications/${selected.applicationId}/submit`, {
                            method: 'POST',
                            body: JSON.stringify({ confirmation })
                          })
                        )
                      }
                    >
                      Submit application
                    </button>
                  </div>
                )}

                {selected.status === 'needs_review' && (
                  <p style={{ fontSize: '12px', color: '#5f6f69', marginTop: '10px', lineHeight: 1.5 }}>
                    💡 <strong>Dual Submit Supported</strong>: You can click "Submit application" above, OR physically click Submit in the open Chromium window. Either way, the engine settles 10 seconds post-submit on site, saves a receipt screenshot to <code>data/submit/</code>, closes the browser, and rests 10s cooldown.
                  </p>
                )}
              </section>
            </>
          );
        })()}
      </main>
    </div>
  );
}
