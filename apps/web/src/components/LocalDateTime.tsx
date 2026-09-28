'use client';

import { useState } from 'react';

/** A datetime-local input in the user's own time zone; submits an ISO-8601 UTC timestamp under `name`. */
export function LocalDateTime({ name, label, required }: { name: string; label: string; required?: boolean }) {
  const [iso, setIso] = useState('');
  return (
    <label>
      {label} <small>(your local time)</small>
      <input
        type="datetime-local"
        required={required}
        aria-label={label}
        onChange={(e) => setIso(e.target.value ? new Date(e.target.value).toISOString() : '')}
      />
      <input type="hidden" name={name} value={iso} />
    </label>
  );
}
