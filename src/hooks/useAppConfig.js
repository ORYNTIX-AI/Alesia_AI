import { useCallback, useEffect, useState } from 'react';

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Запрос не выполнен');
  }
  return payload;
}

export function useAppConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/app-config');
      const payload = await parseJsonResponse(response);
      setConfig(payload);
    } catch (requestError) {
      setError(requestError.message || 'Не удалось загрузить настройки');
    } finally {
      setLoading(false);
    }
  }, []);

  const persistConfig = useCallback(async (nextConfig) => {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/app-config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nextConfig),
      });
      const payload = await parseJsonResponse(response);
      setConfig(payload);
      return payload;
    } catch (requestError) {
      setError(requestError.message || 'Не удалось сохранить настройки');
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    config,
    loading,
    error,
    saving,
    setConfig,
    reload,
    persistConfig,
  };
}
