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

function Field({ field, value, onChange, answers }) {
  if (!visibleWhen(field.visibleWhen, answers)) return null;
  const required = field.required ? <span className="required">*</span> : null;

  if (field.type === 'compound-phone') {
    return <fieldset><legend>{field.label}</legend>{field.children.map(child =>
      <Field key={child.id} field={child} value={answers[child.id]} answers={answers} onChange={onChange} />
    )}</fieldset>;
  }

  if (field.type === 'repeatable-group') {
    return <RepeatableGroup field={field} value={value} onChange={next => onChange(field.id, next)} />;
  }

  if (field.type === 'radio') {
    return <fieldset className="field"><legend>{field.label} {required}</legend><div className="choices">
      {(field.options ?? []).map(option => <label key={option} className="choice">
        <input type="radio" name={field.id} checked={value === option} onChange={() => onChange(field.id, option)} /> {option}
      </label>)}
    </div></fieldset>;
  }

  if (field.type === 'checkbox') {
    return <label className="field choice"><input type="checkbox" checked={Boolean(value)} onChange={event => onChange(field.id, event.target.checked)} /> {field.label} {required}</label>;
  }

  if (field.type === 'multi-checkbox') {
    const selected = Array.isArray(value) ? value : [];
    return <fieldset className="field"><legend>{field.label} {required}</legend><div className="choices">
      {(field.options ?? []).map(option => <label key={option} className="choice"><input type="checkbox" checked={selected.includes(option)} onChange={event => onChange(field.id, event.target.checked ? [...selected, option] : selected.filter(item => item !== option))} /> {option}</label>)}
    </div></fieldset>;
  }

  if (field.type === 'month-year') {
    const date = value && typeof value === 'object' ? value : { month: '', year: '' };
    return <label className="field"><span>{field.label} {required}</span><div className="date-row">
      <input aria-label={`${field.label} month`} placeholder="Month" value={date.month ?? ''} onChange={event => onChange(field.id, { ...date, month: event.target.value })} />
      <input aria-label={`${field.label} year`} placeholder="Year" value={date.year ?? ''} onChange={event => onChange(field.id, { ...date, year: event.target.value })} />
    </div></label>;
  }

  if (field.type === 'textarea') {
    return <label className="field"><span>{field.label} {required}</span><textarea value={value ?? ''} onChange={event => onChange(field.id, event.target.value)} /></label>;
  }

  const inputType = field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text';
  return <label className="field"><span>{field.label} {required}</span><input type={inputType} value={value ?? ''} placeholder={field.type === 'combobox' ? 'Search or enter a value' : ''} onChange={event => onChange(field.id, event.target.value)} /></label>;
}

function RepeatableGroup({ field, value, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const childFields = field.children ?? field.fields ?? [];
  const setRow = (index, childId, childValue) => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [childId]: childValue } : row));
  return <fieldset className="repeatable"><legend>{field.label}</legend>
    {rows.map((row, index) => <div className="repeat-row" key={index}>
      <div className="repeat-header"><strong>{field.label} {index + 1}</strong><button className="secondary danger" type="button" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>Remove</button></div>
      {childFields.map(child => <Field key={child.id} field={child} value={row[child.id]} answers={row} onChange={(id, next) => setRow(index, id, next)} />)}
    </div>)}
    <button className="secondary" type="button" onClick={() => onChange([...rows, {}])}>+ {field.addButton ?? `Add ${field.label}`}</button>
  </fieldset>;
}

function TemplateForm({ template, application, onSaved }) {
  const initial = useMemo(() => Object.fromEntries(Object.entries(application.values ?? {}).map(([id, item]) => [id, item.value])), [application]);
  const [answers, setAnswers] = useState(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => setAnswers(initial), [initial]);
  const update = (id, value) => setAnswers(current => ({ ...current, [id]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const changed = Object.fromEntries(Object.entries(answers).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(initial[id])));
      await api(`/api/applications/${application.applicationId}/answers`, { method: 'PUT', body: JSON.stringify({ updates: changed }) });
      onSaved();
    } finally { setSaving(false); }
  };

  const sections = template.sections ?? (() => {
    const grouped = new Map();
    for (const field of template.fields ?? []) {
      const label = field.sectionLabel ?? 'Application fields';
      const section = grouped.get(label) ?? { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, fields: [] };
      section.fields.push(field);
      grouped.set(label, section);
    }
    const result = [...grouped.values()];
    if (template.repeatableGroups?.length) result.push({ id: 'repeatable_groups', label: 'Work, education and links', groups: template.repeatableGroups });
    return result;
  })();
  return <div className="form-stack">
    {sections.map(section => <section className="form-section" key={section.id}>
      <h2>{section.label}</h2>
      {(section.fields ?? []).map(field => <Field key={field.id} field={field} value={answers[field.id]} answers={answers} onChange={update} />)}
      {(section.groups ?? []).map(group => <RepeatableGroup key={group.id} field={{ ...group, children: group.children ?? group.fields ?? [], label: group.label ?? group.id.replaceAll('_', ' ') }} value={answers[group.id]} onChange={next => update(group.id, next)} />)}
    </section>)}
    <div className="sticky-actions"><button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save answers'}</button></div>
  </div>;
}

export function App() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const refresh = async () => {
    const next = await api('/api/dashboard');
    setData(next);
    setSelectedId(current => current ?? next.applications[0]?.applicationId ?? null);
  };
  useEffect(() => { refresh().catch(error => setError(error.message)); }, []);

  const run = async (label, fn) => {
    setBusy(label); setError('');
    try { await fn(); await refresh(); } catch (error) { setError(error.message); } finally { setBusy(''); }
  };

  if (!data) return <main className="loading">Loading workflow…</main>;
  const selected = data.applications.find(item => item.applicationId === selectedId);
  const template = selected ? data.templates[selected.jobId] : null;

  return <div className="app-shell">
    <aside>
      <div className="brand"><span className="brand-mark">AW</span><div><strong>Apply Workflow</strong><small>Oracle Recruiting Cloud</small></div></div>
      <button className="secondary full" onClick={() => run('Seeding', () => api('/api/seed', { method: 'POST', body: '{}' }))}>Load reconnaissance sample</button>
      <nav>{data.applications.map(application => <button key={application.applicationId} className={`application-card ${selectedId === application.applicationId ? 'active' : ''}`} onClick={() => setSelectedId(application.applicationId)}>
        <span>Job {application.jobId}</span><small>{application.userId}</small><em data-status={application.status}>{application.status.replaceAll('_', ' ')}</em>
      </button>)}</nav>
    </aside>
    <main>
      <header><div><p className="eyebrow">Application review</p><h1>{selected ? `Job ${selected.jobId}` : 'No applications yet'}</h1></div><div className="status">{busy || selected?.status}</div></header>
      {error && <div className="error">{error}</div>}
      {!selected && <div className="empty"><h2>Start with the reconnaissance sample</h2><p>Load the sample to create the first user/job application instance.</p></div>}
      {selected && template && <>
        <div className="workflow-bar"><span className="done">Ingested</span><span className="done">Scanned</span><span className={selected.status !== 'needs_input' ? 'done' : ''}>Answers</span><span className={selected.status === 'needs_review' || selected.status === 'approved' || selected.status === 'submitted' ? 'done' : ''}>Review</span><span className={selected.status === 'submitted' ? 'done' : ''}>Submitted</span></div>
        <TemplateForm template={template} application={selected} onSaved={refresh} />
        <section className="apply-panel"><h2>Browser actions</h2><p>Prepare logs in as this user, fills the live Oracle form, verifies values and stops before Submit.</p>
          <div className="action-row"><button onClick={() => run('Preparing application…', () => api(`/api/applications/${selected.applicationId}/prepare`, { method: 'POST', body: '{}' }))}>Apply and prepare review</button>
          <button className="secondary" disabled={selected.status !== 'needs_review'} onClick={() => run('Approving…', () => api(`/api/applications/${selected.applicationId}/approve`, { method: 'POST', body: '{}' }))}>Approve review</button></div>
          <div className="submit-gate"><label>Type job ID <strong>{selected.jobId}</strong> to submit<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button className="danger" disabled={selected.reviewStatus !== 'approved' || confirmation !== selected.jobId} onClick={() => run('Submitting…', () => api(`/api/applications/${selected.applicationId}/submit`, { method: 'POST', body: JSON.stringify({ confirmation }) }))}>Submit application</button></div>
        </section>
      </>}
    </main>
  </div>;
}
