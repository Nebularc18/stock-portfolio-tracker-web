import { useSettings, TIMEZONES } from '../SettingsContext'

export default function Settings() {
  const { timezone, setTimezone } = useSettings()

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>Settings</h2>
      
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Display Preferences</h3>
        
        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
            Timezone for Market Hours
          </label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            style={{
              width: '100%',
              maxWidth: '400px',
              padding: '12px 16px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.id} value={tz.id}>
                {tz.label}
              </option>
            ))}
          </select>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
            Market opening and closing times will be displayed in your selected timezone.
          </p>
        </div>
      </div>
    </div>
  )
}
