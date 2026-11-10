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

  const isConditionMet = visibleWhen(effectiveCondition, answers);

  if (!isConditionMet && effectiveCondition) {
    const triggerVal = answers ? answers[effectiveCondition.field] : null;
    return (
      <div className="field-group conditional-dormant" style={{ opacity: 0.65, background: '#f8fafc', padding: '10px 14px', borderRadius: '6px', margin: '8px 0', border: '1px dashed #cbd5e1' }}>
        <div className="field-header" style={{ marginBottom: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="field-label" style={{ color: '#475569', fontSize: '13px', fontWeight: 500 }}>
            <span className="conditional-marker" style={{ color: '#94a3b8' }}>↳ </span>
            {field.label}
          </span>
          <span className="badge badge-dormant" style={{ background: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 8px', borderRadius: '12px' }}>
            Not Applicable (Trigger: {triggerVal ? String(triggerVal) : 'No'})
          </span>
        </div>
        <input
          type="text"
          value={value || 'Not Applicable'}
          disabled
          style={{ background: '#f1f5f9', color: '#94a3b8', cursor: 'not-allowed', width: '100%', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '6px 8px', fontSize: '13px' }}
        />
      </div>
    );
  }
  const required = field.required ? <span className="required">*</span> : null;

  const hasLocalValue = value !== null && value !== undefined && String(value).trim().length > 0;
  const isPersistedResolved = Boolean(fieldAudit && fieldAudit.value !== null && fieldAudit.value !== '' && (fieldAudit.confidence ?? 0) >= 0.80);
  const isPendingSave = !isPersistedResolved && hasLocalValue;

  let badgeStatus = 'unresolved';
  let badgeText = 'Unresolved';

  if (isPersistedResolved) {
    badgeStatus = 'resolved';
    const sourceName = fieldAudit?.source ? fieldAudit.source.replace(/^tier\d+_/, '').replace(/_/g, ' ') : '';
    const confidencePercent = fieldAudit?.confidence ? `${Math.round(fieldAudit.confidence * 100)}%` : '';
    badgeText = `Resolved${confidencePercent ? ` (${sourceName ? `${sourceName}, ` : ''}${confidencePercent})` : ''}`;
  } else if (isPendingSave) {
    badgeStatus = 'pending';
    badgeText = 'Selected (Pending Save)';
  }

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
          className={`audit-badge ${badgeStatus}`}
          title={isPersistedResolved ? `Source: ${fieldAudit?.source || 'N/A'}` : isPendingSave ? 'Saved locally; click Save Answers to persist' : 'Requires operator input'}
        >
          <span className={`audit-dot ${badgeStatus === 'unresolved' ? 'red' : 'green'}`} />
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

function RepeatableGroup({ field, value, onChange, persistedGroupValue }) {
  let parsedValue = value;
  if (typeof value === 'string' && value.startsWith('[')) {
    try { parsedValue = JSON.parse(value); } catch {}
  }
  const rows = Array.isArray(parsedValue) ? parsedValue : [];
  const childFields = field.children ?? field.fields ?? [];
  const setRow = (index, childId, childValue) =>
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [childId]: childValue } : row)));

  // Persisted backend rows
  let persistedRows = [];
  if (persistedGroupValue?.value) {
    if (Array.isArray(persistedGroupValue.value)) {
      persistedRows = persistedGroupValue.value;
    } else if (typeof persistedGroupValue.value === 'string' && persistedGroupValue.value.startsWith('[')) {
      try { persistedRows = JSON.parse(persistedGroupValue.value); } catch {}
    }
  }

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
          {childFields.map(child => {
            const childVal = row[child.id] ??
              (/employer|company/i.test(child.id) || /employer|company/i.test(child.label) ? row.company : null) ??
              (/job_title|title/i.test(child.id) || /job\s*title|title/i.test(child.label) ? row.title : null) ??
              (/school|institution|establishment/i.test(child.id) || /school|university/i.test(child.label) ? row.institution : null) ??
              (/degree|content_item_id/i.test(child.id) || /degree/i.test(child.label) ? row.degree : null) ??
              (/major|field/i.test(child.id) || /major|study/i.test(child.label) ? row.fieldOfStudy : null) ??
              (/skills?/i.test(child.id) || /skill/i.test(child.label) ? (row.skills || row.skill) : null) ??
              (/years/i.test(child.id) ? (row.years_of_experience || row.years) : null) ??
              (/language/i.test(child.id) || /language/i.test(child.label) ? (row.language || row.content_item_id) : null) ??
              '';

            const persistedRow = persistedRows[index] || null;
            const persistedChildVal = persistedRow ? (
              persistedRow[child.id] ??
              (/employer|company/i.test(child.id) || /employer|company/i.test(child.label) ? persistedRow.company : null) ??
              (/job_title|title/i.test(child.id) || /job\s*title|title/i.test(child.label) ? persistedRow.title : null) ??
              (/school|institution|establishment/i.test(child.id) || /school|university/i.test(child.label) ? persistedRow.institution : null) ??
              (/degree|content_item_id/i.test(child.id) || /degree/i.test(child.label) ? persistedRow.degree : null) ??
              (/major|field/i.test(child.id) || /major|study/i.test(child.label) ? persistedRow.fieldOfStudy : null) ??
              null
            ) : null;

            const isPersistedOnServer = Boolean(persistedChildVal !== null && persistedChildVal !== undefined && String(persistedChildVal).trim().length > 0);
            const childAudit = isPersistedOnServer ? {
              value: persistedChildVal,
              confidence: persistedGroupValue?.confidence ?? 1.0,
              source: persistedGroupValue?.source ?? 'dashboard',
              reviewed: true
            } : null;

            return (
              <Field
                key={child.id}
                field={child}
                value={childVal}
                answers={row}
                fieldAudit={childAudit}
                onChange={(id, next) => setRow(index, id, next)}
              />
            );
          })}
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
              persistedGroupValue={application.values?.[group.id]}
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

function TopNavbar({
  cas = [],
  selectedCaId,
  onCaChange,
  unassignedCount = 0,
  activeCa,
  onSyncCas,
  onSyncJobs,
  onSyncClients,
  onOpenScan,
  onOpenResolve,
  onRefresh,
  busy
}) {
  const currentDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).replaceAll('/', '-');

  return (
    <div className="top-navbar">
      <div className="top-navbar-left">
        <div className="top-navbar-title">
          <span className="brand-mark" style={{ width: '28px', height: '28px', fontSize: '13px' }}>AW</span>
          <div className="brand-text">
            <strong>APPLYWIZZ</strong>
            <small>Oracle Operator V2</small>
          </div>
        </div>

        <div className="ca-filter-wrapper">
          <label className="ca-filter-label" htmlFor="ca-selector">CA:</label>
          <select
            id="ca-selector"
            className="ca-select"
            value={selectedCaId}
            onChange={e => onCaChange(e.target.value)}
          >
            <option value="all">All CAs ({cas.length})</option>
            <option value="unassigned">Other (Unassigned Clients) ({unassignedCount})</option>
            <optgroup label="Career Associates">
              {cas.map(ca => (
                <option key={ca.id} value={ca.id}>
                  {ca.name} ({ca.dashboardClientCount ?? ca.clientCount ?? 0} clients)
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>

      <div className="top-navbar-center">
        <span className="ist-date-pill">IST: {currentDate}</span>
      </div>

      <div className="top-navbar-actions">
        <button className="nav-btn" disabled={Boolean(busy)} onClick={onSyncCas} title="Sync CAs & Mappings">
          Sync CAs
        </button>
        <button className="nav-btn" disabled={Boolean(busy)} onClick={onSyncJobs}>
          Sync Jobs
        </button>
        <button className="nav-btn" disabled={Boolean(busy)} onClick={onSyncClients}>
          Sync Clients
        </button>
        <button className="nav-btn primary" disabled={Boolean(busy)} onClick={onOpenScan}>
          Scan...
        </button>
        <button className="nav-btn primary" disabled={Boolean(busy)} onClick={onOpenResolve}>
          Resolve...
        </button>
        <button className="nav-btn icon-only" disabled={Boolean(busy)} onClick={onRefresh} title="Refresh Dashboard">
          ↻
        </button>

        <div className="ca-user-pill" title={activeCa?.email || 'All CAs Overview'}>
          <span className="user-avatar-initial">
            {(activeCa?.name || 'A').charAt(0).toUpperCase()}
          </span>
          <span className="user-email-text">
            {activeCa?.email || 'All CAs Overview'}
          </span>
        </div>
      </div>
    </div>
  );
}

function CandidatesDirectory({
  candidates = [],
  totalCandidatesCount = 0,
  selectedClientId,
  onSelectClient,
  assignments = [],
  searchQuery,
  onSearchChange,
  sidebarWidth = '330px',
  onSidebarWidthChange
}) {
  const currentDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).replaceAll('/', '-');

  return (
    <aside className="candidates-directory-sidebar">
      <div className="directory-header">
        <div className="directory-title-row">
          <span className="directory-title">CANDIDATES DIRECTORY</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {onSidebarWidthChange && (
              <div className="sidebar-size-toggle" title="Adjust sidebar width">
                <button
                  type="button"
                  className={`size-btn ${sidebarWidth === '280px' ? 'active' : ''}`}
                  onClick={() => onSidebarWidthChange('280px')}
                  title="Compact (280px)"
                >
                  S
                </button>
                <button
                  type="button"
                  className={`size-btn ${sidebarWidth === '330px' ? 'active' : ''}`}
                  onClick={() => onSidebarWidthChange('330px')}
                  title="Medium (330px)"
                >
                  M
                </button>
                <button
                  type="button"
                  className={`size-btn ${sidebarWidth === '390px' ? 'active' : ''}`}
                  onClick={() => onSidebarWidthChange('390px')}
                  title="Wide (390px)"
                >
                  L
                </button>
              </div>
            )}
            <span className="directory-count-badge">
              {candidates.length} / {totalCandidatesCount}
            </span>
          </div>
        </div>

        <div className="directory-subfilter-row">
          <span className="directory-assigned-pill">
            Assigned: {currentDate} (IST)
          </span>
        </div>

        <div className="directory-search-wrapper">
          <input
            type="text"
            placeholder="Search name or AWL-ID..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="directory-search-input"
          />
          {searchQuery && (
            <button className="search-clear-btn" onClick={() => onSearchChange('')}>×</button>
          )}
        </div>
      </div>

      <div className="candidate-cards-list">
        {candidates.map(c => {
          const isSelected = c.applywizzId === selectedClientId;
          const clientJobsCount = assignments.filter(
            a => (a.applywizzId || a.userId) === c.applywizzId
          ).length;
          const initials = (c.clientName || 'C')
            .split(' ')
            .map(p => p[0])
            .filter(Boolean)
            .slice(0, 2)
            .join('')
            .toUpperCase();

          return (
            <div
              key={c.applywizzId}
              className={`candidate-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectClient(c.applywizzId)}
            >
              <div className="candidate-card-top">
                <div className="candidate-avatar">{initials}</div>
                <div className="candidate-card-ids">
                  <span className="candidate-awl-id">{c.applywizzId}</span>
                  <span className={`candidate-status-pill ${clientJobsCount > 0 ? 'active' : 'pending'}`}>
                    {clientJobsCount > 0 ? '• In progress' : '• Pending'}
                  </span>
                </div>
              </div>
              <div className="candidate-name" title={c.clientName}>
                {c.clientName}
              </div>
              {c.clientEmail && (
                <div className="candidate-email" title={c.clientEmail}>
                  {c.clientEmail}
                </div>
              )}
              <div className="candidate-jobs-footer">
                <span className="jobs-count-badge">{clientJobsCount} Jobs</span>
              </div>
            </div>
          );
        })}
        {candidates.length === 0 && (
          <div className="empty-directory">
            No candidates match current selection.
          </div>
        )}
      </div>
    </aside>
  );
}

function AssignedApplicationsQueue({
  items = [],
  selectedJobKey,
  onSelectJob
}) {
  return (
    <div className="assigned-applications-queue-container">
      <div className="queue-header-row">
        <span className="queue-title">ASSIGNED APPLICATIONS QUEUE</span>
        <div className="queue-badges">
          <span className="queue-active-badge">{items.length} Active</span>
        </div>
      </div>
      <div className="applications-horizontal-track">
        {items.map(item => {
          const isSelected = item.jobKey === selectedJobKey;
          const companyInitial = (item.companyName || 'C').charAt(0).toUpperCase();

          return (
            <div
              key={item.jobKey}
              className={`app-queue-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectJob(item.jobKey)}
            >
              <div className="app-queue-card-top">
                <span className="app-queue-company-avatar">{companyInitial}</span>
                <span className="app-queue-company" title={item.companyName}>
                  {item.companyName}
                </span>
                <span className={`app-queue-status-pill ${item.status}`}>
                  {item.status.replaceAll('_', ' ')}
                </span>
              </div>
              <div className="app-queue-title" title={item.title}>
                {item.title}
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="empty-queue-message">
            No applications found for this candidate.
          </div>
        )}
      </div>
    </div>
  );
}

function ScannerLivePanel({ status, onCancel }) {
  if (!status || (!status.isScanning && (!status.slots || status.slots.every(s => s.status === 'idle')))) {
    return null;
  }
  const { slots = [], summary = {}, isScanning } = status;

  return (
    <div className="scanner-live-panel">
      <div className="scanner-panel-header">
        <div className="scanner-panel-title">
          <span>{isScanning ? '🔄 Active 3-Worker Scanner Queue' : 'Scanner Queue Idle'}</span>
          {summary.total > 0 && (
            <span className="queue-pill has-pending">
              Completed: <strong>{summary.completed || 0}</strong> / {summary.total || 0} | Skipped: {summary.skipped || 0} | Failed: {summary.failed || 0}
            </span>
          )}
        </div>
        <div className="scanner-panel-controls">
          {isScanning && (
            <button className="danger btn-inline" onClick={onCancel}>
              ⏹ Cancel Queue
            </button>
          )}
        </div>
      </div>
      <div className="scanner-slots-grid">
        {slots.map(slot => (
          <div key={slot.slotId} className={`scanner-slot ${slot.status !== 'idle' ? 'active' : ''} ${slot.status === 'cooldown' ? 'cooldown' : ''}`}>
            <div className="slot-top">
              <span>Worker {slot.slotId}</span>
              <span className={`slot-badge ${slot.status}`}>
                {slot.status}
              </span>
            </div>
            {slot.jobKey ? (
              <>
                <div className="scanner-slot-job">{slot.jobKey}</div>
                <div className="scanner-slot-step">{slot.step || 'Processing...'}</div>
                <div className="slot-details"><span>{slot.email}</span></div>
              </>
            ) : (
              <div className="slot-details" style={{ color: '#909e98' }}>Slot Idle</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ScanModal({ isOpen, onClose, onLaunch, isScanning }) {
  const [mode, setMode] = useState('all');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [jobKeys, setJobKeys] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isScanning) return;
    const options = {};
    if (mode === 'range') {
      if (rangeFrom && rangeTo) {
        options.range = `${rangeFrom}-${rangeTo}`;
      } else if (rangeFrom) {
        options.range = `${rangeFrom}`;
      }
    } else if (mode === 'jobs') {
      options.jobs = jobKeys.split(',').map(s => s.trim()).filter(Boolean);
    }
    onLaunch(options);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={e => e.stopPropagation()}>
        <h2>Launch Scanner Queue</h2>
        <p>Extract Oracle application form schemas using 3 headless workers and 3 dummy emails.</p>

        {isScanning && (
          <div className="action-toast warning">
            A scan queue is currently active. Wait for it to finish or cancel it from the panel.
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="modal-options">
            <label className={`modal-option ${mode === 'all' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="scanMode" checked={mode === 'all'} onChange={() => setMode('all')} />
                All Pending Jobs (Unscanned)
              </div>
            </label>

            <label className={`modal-option ${mode === 'range' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="scanMode" checked={mode === 'range'} onChange={() => setMode('range')} />
                Target Numeric Range (e.g. 210-235)
              </div>
              {mode === 'range' && (
                <div className="modal-range-inputs">
                  <input
                    type="text"
                    placeholder="From (e.g. 210)"
                    value={rangeFrom}
                    onChange={e => setRangeFrom(e.target.value)}
                    required
                  />
                  <input
                    type="text"
                    placeholder="To (e.g. 235)"
                    value={rangeTo}
                    onChange={e => setRangeTo(e.target.value)}
                    required
                  />
                </div>
              )}
            </label>

            <label className={`modal-option ${mode === 'jobs' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="scanMode" checked={mode === 'jobs'} onChange={() => setMode('jobs')} />
                Specific Job Keys (Comma-separated)
              </div>
              {mode === 'jobs' && (
                <input
                  type="text"
                  placeholder="e.g. job_211, job_215, job_234"
                  value={jobKeys}
                  onChange={e => setJobKeys(e.target.value)}
                  style={{ marginTop: '6px' }}
                  required
                />
              )}
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={isScanning} className="primary">
              Launch Scanner
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResolveModal({ isOpen, onClose, onLaunch, clients = [] }) {
  const [mode, setMode] = useState('all');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [selectedClient, setSelectedClient] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const options = {};
    if (mode === 'range') {
      if (rangeFrom && rangeTo) {
        options.range = `${rangeFrom}-${rangeTo}`;
      } else if (rangeFrom) {
        options.range = `${rangeFrom}`;
      }
    } else if (mode === 'client') {
      options.client = selectedClient;
    }
    onLaunch(options);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={e => e.stopPropagation()}>
        <h2>Resolve Applications (Phase 3)</h2>
        <p>Match candidate profiles, historical question bank, and resume text against scanned form templates.</p>

        <form onSubmit={handleSubmit}>
          <div className="modal-options">
            <label className={`modal-option ${mode === 'all' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="resolveMode" checked={mode === 'all'} onChange={() => setMode('all')} />
                All Scanned Applications
              </div>
            </label>

            <label className={`modal-option ${mode === 'range' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="resolveMode" checked={mode === 'range'} onChange={() => setMode('range')} />
                By Job Key Range (e.g. 210-235)
              </div>
              {mode === 'range' && (
                <div className="modal-range-inputs">
                  <input
                    type="text"
                    placeholder="From (e.g. 210)"
                    value={rangeFrom}
                    onChange={e => setRangeFrom(e.target.value)}
                    required
                  />
                  <input
                    type="text"
                    placeholder="To (e.g. 235)"
                    value={rangeTo}
                    onChange={e => setRangeTo(e.target.value)}
                    required
                  />
                </div>
              )}
            </label>

            <label className={`modal-option ${mode === 'client' ? 'selected' : ''}`}>
              <div className="modal-option-radio">
                <input type="radio" name="resolveMode" checked={mode === 'client'} onChange={() => setMode('client')} />
                By Specific Candidate
              </div>
              {mode === 'client' && (
                <select
                  value={selectedClient}
                  onChange={e => setSelectedClient(e.target.value)}
                  style={{ marginTop: '6px' }}
                  required
                >
                  <option value="">Select Candidate...</option>
                  {clients.map(c => (
                    <option key={c.applywizzId} value={c.applywizzId}>
                      {c.clientName} ({c.applywizzId})
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Run Resolution
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AuditProofsGallery({ screenshots = [], logs = [], applicationId, fillCompletedAt, status }) {
  const [selectedImage, setSelectedImage] = useState(null);
  const [showLogs, setShowLogs] = useState(false);

  if (!screenshots || screenshots.length === 0) return null;

  return (
    <div className="audit-gallery-section">
      <div className="audit-gallery-header">
        <div>
          <div className="audit-gallery-title">
            <span className="audit-gallery-icon">📸</span>
            Visual Audit Proofs ({screenshots.length} Page Captures)
          </div>
          <p className="audit-gallery-subtitle">
            Screenshots captured before each "Next" button click and upon detecting the final "Submit" button.
            {status === 'filled_verified' && (
              <span className="audit-dry-run-pill">Dry-Run Mode • Submit Held • Worker Freed</span>
            )}
          </p>
        </div>
        {fillCompletedAt && (
          <div className="audit-timestamp">
            Audited {new Date(fillCompletedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        )}
      </div>

      <div className="audit-thumbnails-grid">
        {screenshots.map((s, idx) => {
          const imgUrl = `/api/applications/${applicationId}/screenshots/${s.filename}`;
          const isSubmit = s.step === 'final_submit';
          return (
            <div
              key={idx}
              className={`audit-thumbnail-card ${isSubmit ? 'submit-step' : ''}`}
              onClick={() => setSelectedImage({ url: imgUrl, label: s.label || `Page ${s.pageNumber}`, filename: s.filename })}
            >
              <div className="audit-card-badge">
                {isSubmit ? '🏁 Final Submit Detected' : `📄 ${s.label || `Page ${s.pageNumber}`}`}
              </div>
              <div className="audit-img-wrapper">
                <img
                  src={imgUrl}
                  alt={s.label || `Audit Page ${s.pageNumber}`}
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex';
                  }}
                />
                <div className="audit-img-fallback" style={{ display: 'none' }}>
                  <span>Preview Unavailable</span>
                </div>
                <div className="audit-zoom-overlay">
                  <span>🔍 View Full Resolution</span>
                </div>
              </div>
              <div className="audit-card-footer">
                <span className="audit-filename">{s.filename}</span>
                {s.capturedAt && (
                  <span className="audit-time">
                    {new Date(s.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {logs && logs.length > 0 && (
        <div className="audit-logs-container">
          <button
            type="button"
            className="audit-logs-toggle"
            onClick={() => setShowLogs(!showLogs)}
          >
            <span>{showLogs ? '▼' : '►'} Execution & Verification Logs ({logs.length} events)</span>
            <span className="audit-logs-badge">All DOM Fields Verified</span>
          </button>
          {showLogs && (
            <div className="audit-logs-list">
              {logs.map((log, i) => (
                <div key={i} className="audit-log-entry">
                  <span className="audit-log-dot">✓</span>
                  <span className="audit-log-text">{typeof log === 'string' ? log : (log.message || JSON.stringify(log))}</span>
                  {log.timestamp && (
                    <span className="audit-log-time">
                      {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedImage && (
        <div className="modal-backdrop" onClick={() => setSelectedImage(null)}>
          <div className="audit-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="audit-modal-header">
              <div>
                <h3>{selectedImage.label}</h3>
                <small>{selectedImage.filename}</small>
              </div>
              <button className="nav-btn icon-only" onClick={() => setSelectedImage(null)}>✕</button>
            </div>
            <div className="audit-modal-body">
              <img src={selectedImage.url} alt={selectedImage.label} />
            </div>
            <div className="audit-modal-footer">
              <button className="secondary" onClick={() => setSelectedImage(null)}>Close Preview</button>
              <a href={selectedImage.url} target="_blank" rel="noreferrer" className="nav-btn primary">
                Open in New Tab ↗
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedCaId, setSelectedCaId] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedJobKey, setSelectedJobKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submissionStatus, setSubmissionStatus] = useState(null);
  const [scannerStatus, setScannerStatus] = useState(null);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [notification, setNotification] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState('330px');
  const [copiedUrl, setCopiedUrl] = useState(false);

  const refresh = async () => {
    const next = await api('/api/dashboard');
    setData(next);
    if (next.submissionStatus) setSubmissionStatus(next.submissionStatus);
  };

  useEffect(() => {
    refresh().catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    const fetchStatuses = async () => {
      try {
        const [subStatus, scStatus] = await Promise.all([
          api('/api/submission/status').catch(() => null),
          api('/api/scan/status').catch(() => null)
        ]);
        if (subStatus) setSubmissionStatus(subStatus);
        if (scStatus) setScannerStatus(scStatus);
      } catch {}
    };
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 2500);
    return () => clearInterval(interval);
  }, []);

  // Default to first active CA with dashboard clients
  useEffect(() => {
    if (!data?.cas?.length) return;
    if (!selectedCaId) {
      const firstActive = data.cas.find(c => (c.dashboardClientCount || 0) > 0);
      const defaultCaId = firstActive ? firstActive.id : 'all';
      setSelectedCaId(defaultCaId);
    }
  }, [data]);

  const activeCa = useMemo(() => {
    if (!data?.cas || !selectedCaId || selectedCaId === 'all' || selectedCaId === 'unassigned') return null;
    return data.cas.find(c => c.id === selectedCaId) || null;
  }, [data, selectedCaId]);

  const filteredCandidates = useMemo(() => {
    if (!data?.clients) return [];
    let list = data.clients;

    if (selectedCaId === 'unassigned') {
      list = list.filter(c => !c.caId && !data.clientToCaMap?.[c.applywizzId]);
    } else if (selectedCaId && selectedCaId !== 'all') {
      list = list.filter(c => {
        const caInfo = data.clientToCaMap?.[c.applywizzId];
        return c.caId === selectedCaId || caInfo?.caId === selectedCaId;
      });
    }

    if (candidateSearch.trim()) {
      const q = candidateSearch.toLowerCase().trim();
      list = list.filter(c =>
        (c.clientName && c.clientName.toLowerCase().includes(q)) ||
        (c.applywizzId && c.applywizzId.toLowerCase().includes(q)) ||
        (c.clientEmail && c.clientEmail.toLowerCase().includes(q))
      );
    }
    return list;
  }, [data, selectedCaId, candidateSearch]);

  const handleClientSelect = (newClientId) => {
    setSelectedClientId(newClientId);
    if (!data) return;

    // Pick first application instance from data.applications
    const clientApps = (data.applications || []).filter(
      a => (a.applywizzId || a.userId) === newClientId
    );
    const firstApp = clientApps[0];
    const firstJobKey = firstApp?.jobKey || firstApp?.jobId || '';
    setSelectedJobKey(firstJobKey);
    setSelectedId(firstApp?.applicationId || null);
  };

  const handleJobSelect = (newJobKey) => {
    setSelectedJobKey(newJobKey);
    if (!data) return;

    const matchingApp = data.applications.find(
      a =>
        (a.userId === selectedClientId || a.applywizzId === selectedClientId) &&
        (a.jobKey === newJobKey || a.jobId === newJobKey)
    );
    setSelectedId(matchingApp?.applicationId || null);
  };

  // Sync selected application when candidates list changes or loads
  useEffect(() => {
    if (!filteredCandidates.length) {
      setSelectedClientId('');
      setSelectedJobKey('');
      setSelectedId(null);
      return;
    }
    const isCurrentInList = filteredCandidates.some(c => c.applywizzId === selectedClientId);
    if (!isCurrentInList) {
      handleClientSelect(filteredCandidates[0].applywizzId);
    }
  }, [filteredCandidates]);

  // Derive active applications strictly from resolved application instances
  const candidateAppsWithJobs = useMemo(() => {
    if (!selectedClientId || !data?.applications) return [];
    return data.applications
      .filter(a => (a.userId === selectedClientId || a.applywizzId === selectedClientId))
      .map(app => {
        const jobKey = app.jobKey || app.jobId;
        return {
          job: app,
          jobKey,
          companyName: app.companyName || 'Company',
          jobId: app.jobId,
          title: app.clientName ? `${app.companyName || 'Company'} (${jobKey})` : `Job ${jobKey}`,
          application: app,
          status: app.status || 'needs_input',
          reviewStatus: app.reviewStatus || 'not_ready'
        };
      });
  }, [data, selectedClientId]);

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

  const handleSyncCas = async () => {
    run('Syncing CAs...', async () => {
      const res = await api('/api/cas/sync', { method: 'POST' });
      setNotification({
        type: 'success',
        message: `Synced ${res.totalCas || 0} Career Associates with ${res.totalAssignedClients || 0} assigned clients!`
      });
    });
  };

  const handleSyncJobs = async () => {
    run('Syncing Jobs...', async () => {
      const res = await api('/api/jobs/sync', { method: 'POST' });
      setNotification({
        type: 'success',
        message: `Jobs synced! ${res.newJobsCreated || 0} new unique jobs registered (Total: ${res.totalUniqueJobs || 0}).`
      });
    });
  };

  const handleSyncClients = async () => {
    run('Starting client sync...', async () => {
      await api('/api/clients/sync', { method: 'POST' });
      setNotification({
        type: 'success',
        message: 'Client sync started in background. Profiles and resumes are caching to Supabase.'
      });
    });
  };

  const handleLaunchScan = async (options) => {
    try {
      await api('/api/scan/queue', {
        method: 'POST',
        body: JSON.stringify(options)
      });
      setNotification({
        type: 'success',
        message: 'Scanner queue started! Watch live progress in the activity panel.'
      });
      const scStatus = await api('/api/scan/status').catch(() => null);
      if (scStatus) setScannerStatus(scStatus);
    } catch (err) {
      setNotification({
        type: 'warning',
        message: err.message
      });
    }
  };

  const handleCancelScan = async () => {
    try {
      await api('/api/scan/cancel', { method: 'POST' });
      setNotification({
        type: 'warning',
        message: 'Cancel signal sent. Workers will halt after the current step.'
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const handleLaunchResolve = async (options) => {
    run('Resolving applications...', async () => {
      const res = await api('/api/resolve', {
        method: 'POST',
        body: JSON.stringify(options)
      });
      const rate = res?.batchSummary?.resolutionRate || res?.globalSummary?.globalResolutionRate || '';
      setNotification({
        type: 'success',
        message: `Resolution complete! Resolved rate: ${rate}.`
      });
    });
  };

  if (!data) return <main className="loading">Loading workflow…</main>;

  const selected = data.applications.find(item => item.applicationId === selectedId);
  const template = selected
    ? (data.templates[selected.jobKey] ||
       data.templates[selected.jobId] ||
       Object.values(data.templates).find(t => t.jobId === selected.jobId || t.jobKey === selected.jobKey || t.id === selected.templateId))
    : null;

  const selectedJobInfo = (() => {
    if (!selected) return { jobUrl: null, companyName: null };

    let url = selected.canonicalUrl || selected.originalUrl || selected.jobUrl || selected.url;
    let company = selected.companyName;

    if (!url || !company) {
      const uniqueJob = data?.jobs?.uniqueJobs?.find(
        j => (j.jobKey && (j.jobKey === selected.jobKey || j.jobKey === selected.jobId)) ||
             (j.jobId && (j.jobId === selected.jobId || j.jobId === selected.jobKey))
      );
      if (!url) url = uniqueJob?.canonicalUrl || uniqueJob?.originalUrl;
      if (!company) company = uniqueJob?.companyName;
    }

    if (!url || !company) {
      const assignment = data?.jobs?.assignments?.find(
        a => (a.jobKey && (a.jobKey === selected.jobKey || a.jobKey === selected.jobId)) ||
             (a.jobId && (a.jobId === selected.jobId || a.jobId === selected.jobKey))
      );
      if (!url) url = assignment?.canonicalUrl || assignment?.originalUrl;
      if (!company) company = assignment?.companyName;
    }

    if (!url && template?.canonicalUrl) {
      url = template.canonicalUrl;
    }

    return { jobUrl: url, companyName: company };
  })();

  return (
    <div className="dashboard-app-container" style={{ '--sidebar-width': sidebarWidth }}>
      {/* 1. Full-Width Edge-to-Edge Top Header Bar */}
      <TopNavbar
        cas={data.cas || []}
        selectedCaId={selectedCaId}
        onCaChange={setSelectedCaId}
        unassignedCount={data.unassignedClientsCount || 0}
        activeCa={activeCa}
        onSyncCas={handleSyncCas}
        onSyncJobs={handleSyncJobs}
        onSyncClients={handleSyncClients}
        onOpenScan={() => setShowScanModal(true)}
        onOpenResolve={() => setShowResolveModal(true)}
        onRefresh={refresh}
        busy={busy}
      />

      {/* 2. Full-Width Notifications / Toasts */}
      {notification && (
        <div className="dashboard-banner-wrap">
          <div className={`action-toast ${notification.type}`}>
            <span>{notification.message}</span>
            <button className="toast-close" onClick={() => setNotification(null)}>×</button>
          </div>
        </div>
      )}

      {/* 3. Live Scanner Queue Panel */}
      {scannerStatus?.isScanning && (
        <div className="dashboard-banner-wrap">
          <ScannerLivePanel
            status={scannerStatus}
            onCancel={handleCancelScan}
          />
        </div>
      )}

      {/* 4. Full Horizontal Stats Scroll Directly Below Top Bar */}
      <div className="metrics-section">
        <ExecutiveMetrics metrics={data.metrics} />
      </div>

      {/* 5. Lower Workspace: Two-Column Split (Adjustable) */}
      <div className="dashboard-body-split">
        {/* Candidates Directory Left Sidebar */}
        <CandidatesDirectory
          candidates={filteredCandidates}
          totalCandidatesCount={data.clients?.length || 0}
          selectedClientId={selectedClientId}
          onSelectClient={handleClientSelect}
          assignments={data.applications || []}
          searchQuery={candidateSearch}
          onSearchChange={setCandidateSearch}
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
        />

        <main className="dashboard-main-content">
          {/* 3-Browser Concurrency Worker Pool Widget */}
          <WorkerPoolWidget status={submissionStatus} />

          {/* Top Horizontal Queue: Assigned Applications Queue */}
          <AssignedApplicationsQueue
            items={candidateAppsWithJobs}
            selectedJobKey={selectedJobKey}
            onSelectJob={handleJobSelect}
          />

        <header>
          <div>
            <p className="eyebrow">Application review</p>
            <h1>
              {selected
                ? `${selected.jobKey || `Job ${selected.jobId}`} - ${selected.clientName || selected.userId}`
                : 'Select an application'}
            </h1>
            {selected && (
              <div className="header-job-meta">
                {selectedJobInfo.companyName && (
                  <span className="header-company-tag">{selectedJobInfo.companyName}</span>
                )}
                {selectedJobInfo.jobUrl && (
                  <div className="header-job-link-row">
                    <span className="url-icon">🔗</span>
                    <a
                      href={selectedJobInfo.jobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="job-link"
                      title={selectedJobInfo.jobUrl}
                    >
                      {selectedJobInfo.jobUrl}
                    </a>
                    <button
                      type="button"
                      className="copy-url-btn"
                      onClick={() => {
                        if (navigator.clipboard) {
                          navigator.clipboard.writeText(selectedJobInfo.jobUrl);
                          setCopiedUrl(true);
                          setTimeout(() => setCopiedUrl(false), 2000);
                        }
                      }}
                      title="Copy Job URL to clipboard"
                    >
                      {copiedUrl ? '✓ Copied' : '📋 Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {selectedJobInfo.jobUrl && (
              <a
                href={selectedJobInfo.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="nav-btn primary btn-inline"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                title="Open official Oracle job requisition page in new tab"
              >
                ↗ Open Job URL
              </a>
            )}
            {selected && (
              <button
                className="secondary btn-inline"
                onClick={() => handleLaunchResolve({ client: selected.userId || selected.applywizzId })}
              >
                ⚡ Resolve Candidate
              </button>
            )}
            <div className="status">{busy || selected?.status || 'No selection'}</div>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        {!selected && (
          <div className="empty">
            <h2>Application Not Yet Generated</h2>
            <p>
              An application instance for this candidate and job has not been generated yet. Run{' '}
              <code>npm run resolve:answers</code> or click <strong>Resolve...</strong> in the top navbar.
            </p>
          </div>
        )}

        {selected && !template && (
          <div className="empty">
            <h2>Form Template Not Scanned</h2>
            <p>
              The form for requisition <strong>{selected.jobKey || selected.jobId}</strong> has not been scanned yet. Run the scanner queue to extract form fields.
            </p>
            <button
              className="primary btn-inline"
              style={{ marginTop: '12px' }}
              onClick={() => handleLaunchScan({ jobs: [selected.jobKey || selected.jobId] })}
            >
              ⚡ Scan Requisition {selected.jobKey || selected.jobId}
            </button>
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
          } else if (selected.status === 'filled_verified') {
            applyButtonText = '✓ Filled & Audited (Click to Re-run)';
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
                    selected.status === 'filled_verified' ||
                    selected.status === 'needs_review' ||
                    selected.status === 'approved' ||
                    selected.status === 'submitted'
                      ? 'done'
                      : ''
                  }
                >
                  {selected.status === 'filled_verified' ? 'Audited' : 'Review'}
                </span>
                <span className={selected.status === 'submitted' ? 'done' : ''}>Submitted</span>
              </div>

              <TemplateForm template={template} application={selected} onSaved={refresh} />

              <AuditProofsGallery
                screenshots={selected.screenshots || []}
                logs={selected.fillLogs || []}
                applicationId={selected.applicationId}
                fillCompletedAt={selected.fillCompletedAt}
                status={selected.status}
              />

              <section className="apply-panel">
                <h2>Live Submission Engine (Max 3 Browsers)</h2>
                <p>
                  Authenticates with real candidate <strong>company_email</strong>, attaches cached resume, fills multi-page form, captures audit proofs, and auto-closes in dry-run mode.
                </p>

                {selected.status === 'filled_verified' && (
                  <div className="verified-dryrun-banner">
                    <strong>✓ Form Fields Filled & Verified on Live Oracle Portal</strong>
                    <div>
                      Visual audit screenshots were captured before advancing each page and on detecting the final Submit button.
                    </div>
                    <div>
                      Submission was paused in <strong>Dry-Run Mode</strong>, and the browser session was cleanly closed so worker slots remain free for queued candidate applications.
                    </div>
                  </div>
                )}

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

        <ScanModal
          isOpen={showScanModal}
          onClose={() => setShowScanModal(false)}
          onLaunch={handleLaunchScan}
          isScanning={scannerStatus?.isScanning}
        />

        <ResolveModal
          isOpen={showResolveModal}
          onClose={() => setShowResolveModal(false)}
          onLaunch={handleLaunchResolve}
          clients={data.clients || []}
        />
      </main>
    </div>
  </div>
  );
}
