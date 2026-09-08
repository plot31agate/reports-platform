/* setup.tsx — the shared vocabulary of client setup.

   One set of editors for the reporting-core config, used by BOTH the new-client
   wizard and the client sheet's Setup tab, so "what a client needs" is defined
   once and edited in one visual language everywhere:

   - SectionsPicker: which report sections this client's reports include
   - LinesArea: list fields (competitors, executives, keywords, queries)
   - ConnectionFields: one provider's per-client settings (GA4 property, GSC
     site, Ahrefs target…), with an agency-key pill so it's obvious when a
     provider can't sync yet no matter what's typed here.

   When the snapshot hasn't loaded (offline preview) FALLBACK_META mirrors the
   backend defs so the wizard still renders. */
import type { ReactNode } from 'react';
import type { SetupMeta, SectionDef, ConnectorDef } from '../lib/agency';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span className="small" style={{ color: 'var(--muted)', fontWeight: 500 }}>{label}</span>
      {children}
      {hint && <span className="small" style={{ color: 'var(--faint)', fontSize: 11.5, lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}

/* ---- list fields as one-per-line textareas ---- */
export const toLines = (xs: string[] | undefined) => (xs ?? []).join('\n');
export const fromLines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export function LinesArea({ label, hint, placeholder, value, onChange, rows = 3 }: {
  label: string; hint?: string; placeholder?: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className="inp" rows={rows} placeholder={placeholder} value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
      />
    </Field>
  );
}

/* ---- report sections ---- */
export function SectionsPicker({ defs, chosen, onToggle }: {
  defs: SectionDef[]; chosen: string[]; onToggle: (key: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {defs.map((d) => {
        const on = chosen.includes(d.key);
        return (
          <button
            key={d.key} type="button"
            className={`chiptoggle ${on ? 'on' : ''}`}
            title={d.hint}
            onClick={() => onToggle(d.key)}
          >
            {on ? '✓ ' : ''}{d.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---- one provider's client fields ---- */
export function ConnectionFields({ def, hasAgencyKey, values, onChange, extra }: {
  def: ConnectorDef;
  hasAgencyKey: boolean;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Optional action row rendered next to the provider name (Save / Test). */
  extra?: ReactNode;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{def.label}</span>
        {hasAgencyKey
          ? <span className="pill pass">agency key on file</span>
          : <span className="pill warn">no agency key yet</span>}
        <div style={{ flex: 1 }} />
        {extra}
      </div>
      <p className="small" style={{ margin: '0 0 10px', color: 'var(--faint)', lineHeight: 1.5 }}>{def.blurb}</p>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {def.client_fields.map((f) => (
          <div key={f.key} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
            <Field label={f.label} hint={f.hint}>
              {f.type === 'textarea' ? (
                <textarea
                  className="inp" rows={3} placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                />
              ) : (
                <input
                  className="inp"
                  type={f.secret ? 'password' : 'text'}
                  placeholder={f.secret && values[f.key] === '•set•' ? '•••••••• (saved — blank keeps it)' : f.placeholder}
                  value={f.secret && values[f.key] === '•set•' ? '' : (values[f.key] ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
              )}
            </Field>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- offline fallback meta (mirrors app/reports/sections.py + connectors) ---- */
export const FALLBACK_META: SetupMeta = {
  section_defs: [
    { key: 'glance', label: 'At a glance', hint: 'Traffic-light status strip at the top of the report', default: false },
    { key: 'media', label: 'Media coverage & sentiment', hint: 'Earned coverage, sentiment, executive visibility', default: true },
    { key: 'sov', label: 'Share of voice', hint: 'Organic search share vs competitors', default: true },
    { key: 'traffic', label: 'Search & site traffic', hint: 'GA4, Search Console, core keyword rankings', default: true },
    { key: 'trends', label: 'Daily trends', hint: 'Day-by-day GA4 charts vs the previous month', default: false },
    { key: 'geography', label: 'Geography', hint: 'Visits by country', default: true },
    { key: 'links', label: 'Authority & backlinks', hint: 'Domain rating, referring domains, trends', default: true },
    { key: 'linkedin', label: 'LinkedIn', hint: 'Followers, impressions, top posts', default: true },
    { key: 'social', label: 'Facebook & Instagram', hint: 'Views, reach, interactions per platform', default: false },
    { key: 'tiktok', label: 'TikTok', hint: 'Views, likes, comments, shares', default: false },
    { key: 'influencers', label: 'Influencer activity', hint: 'Creator posts with reach and engagement', default: false },
    { key: 'technical_seo', label: 'Technical SEO', hint: 'Site health score and issue register', default: true },
    { key: 'misc', label: 'Misc (custom section)', hint: 'A free-text section written on the review screen', default: false },
  ],
  connectors: [
    {
      provider: 'google', label: 'Google — GA4 & Search Console',
      blurb: 'One service account covers GA4 traffic, geography and Search Console.',
      client_fields: [
        { key: 'ga4_property_id', label: 'GA4 property ID', placeholder: '123456789', hint: 'GA4 → Admin → Property settings (numbers only)' },
        { key: 'gsc_site_url', label: 'Search Console property', placeholder: 'example.com or https://www.example.com/' },
      ],
    },
    {
      provider: 'ahrefs', label: 'Ahrefs',
      blurb: 'Backlinks, authority trends, core keywords, competitor benchmark, technical SEO.',
      client_fields: [
        { key: 'target', label: 'Target domain', placeholder: 'example.com' },
        { key: 'audit_project_id', label: 'Ahrefs project ID', placeholder: 'e.g. 123456' },
        { key: 'core_keywords', label: 'Core keywords', type: 'textarea', placeholder: 'One keyword per line' },
        { key: 'keyword_country', label: 'Keyword market', placeholder: 'optional, e.g. GB' },
        { key: 'competitor_domains', label: 'Competitor domains', placeholder: 'optional override' },
      ],
    },
    {
      provider: 'meta', label: 'Meta — Facebook & Instagram',
      blurb: 'Facebook Page and Instagram daily insights.',
      client_fields: [
        { key: 'fb_page_id', label: 'Facebook Page ID', placeholder: 'e.g. 1234567890' },
        { key: 'ig_user_id', label: 'Instagram account ID', placeholder: 'optional' },
      ],
    },
    {
      provider: 'serper', label: 'Serper — Google News mentions',
      blurb: 'Media mentions from Google News by search query.',
      client_fields: [
        { key: 'mention_queries', label: 'Search queries', type: 'textarea', placeholder: 'One phrase per line — blank uses brand + executives' },
      ],
    },
  ],
};

/** Guess the Ahrefs target from a website URL — a small nicety in the wizard. */
export function domainOf(url: string): string {
  try { return new URL(url.startsWith('http') ? url : `https://${url}`).host.replace(/^www\./, ''); }
  catch { return ''; }
}
