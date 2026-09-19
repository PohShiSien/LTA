/** Reusable JagaRail wordmark: a shield (protection) enclosing a monitored rail line. See docs/BRANDING.md. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="JagaRail mark">
    <path d="M32 5 L53 13 V29 C53 45 44 55 32 59 C20 55 11 45 11 29 V13 Z" fill="#0B1220" stroke="#20A4A9" strokeWidth="3" strokeLinejoin="round" />
    <circle cx="32" cy="21" r="4.5" fill="#20A4A9" />
    <path d="M17 38 H47" stroke="#20A4A9" strokeWidth="4.5" strokeLinecap="round" />
    <path d="M23 38 V31 M32 38 V29 M41 38 V31" stroke="#20A4A9" strokeWidth="3.4" strokeLinecap="round" />
  </svg>;
}

export function Wordmark({ size = 22, withTagline = false }: { size?: number; withTagline?: boolean }) {
  return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: size, letterSpacing: '-.3px' }}>
      <LogoMark size={size * 1.5} />JagaRail
    </span>
    {withTagline && <span style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--text-on-dark-muted)', marginLeft: size * 1.5 + 10 }}>Evidence in Context</span>}
  </span>;
}
