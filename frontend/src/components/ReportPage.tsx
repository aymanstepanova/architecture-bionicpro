import React, { useEffect, useMemo, useState } from 'react';

type MeResponse =
  | { authenticated: true; user: { email?: string | null; name?: string | null; subject: string } }
  | { authenticated: false };

type ReportUrlResponse = {
  url: string;
  cache?: 'hit' | 'miss';
  available_to?: string | null;
};

function ReportPage() {
  const apiBase = useMemo(() => process.env.REACT_APP_API_URL || '', []);
  const reportsBase = useMemo(() => process.env.REACT_APP_REPORTS_URL || apiBase, [apiBase]);
  const [initialized, setInitialized] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<unknown>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);

  const login = () => {
    const returnTo = window.location.href;
    window.location.href = `${apiBase}/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const loadMe = async () => {
    const url = apiBase ? `${apiBase.replace(/\/$/, '')}/me` : '/me';
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      if (!resp.ok) {
        setMe({ authenticated: false });
        return;
      }
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setMe({ authenticated: false });
        return;
      }
      const json = (await resp.json()) as MeResponse;
      setMe(json);
    } catch {
      setMe({ authenticated: false });
    } finally {
      window.clearTimeout(t);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadMe();
      } finally {
        if (!cancelled) setInitialized(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadReport = async () => {
    try {
      setLoading(true);
      setError(null);
      setReport(null);
      setCacheStatus(null);

      const response = await fetch(`${reportsBase}/reports/url`, {
        credentials: 'include'
      });

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 409) {
          throw new Error(`Отчёт за период ещё не готов. ${text}`);
        }
        throw new Error(`Failed to fetch report: ${response.status} ${text}`);
      }

      const json = (await response.json()) as ReportUrlResponse;
      if (!json?.url) throw new Error('Reports API did not return url');
      if (json.cache) setCacheStatus(`cache: ${json.cache}`);

      // Trigger browser download via CDN URL
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (!initialized) {
    return <div>Loading...</div>;
  }

  if (!me || me.authenticated === false) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
        <button
          onClick={login}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Login
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
      <div className="p-8 bg-white rounded-lg shadow-md">
        {[
          <h1 key="title" className="text-2xl font-bold mb-6">
            Usage Reports
          </h1>,
          <div key="signed" className="mb-4 text-sm text-gray-700">
            Signed in as <span className="font-semibold">{me.user.email || me.user.name || me.user.subject}</span>
          </div>,
          <button
            key="dl"
            type="button"
            onClick={downloadReport}
            disabled={loading}
            className={`px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 ${
              loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {loading ? 'Generating Report...' : 'Download Report'}
          </button>,
          cacheStatus ? (
            <div key="cache" className="mt-3 text-sm text-gray-600">
              {cacheStatus}
            </div>
          ) : null,
          error ? (
            <div key="err" className="mt-4 p-4 bg-red-100 text-red-700 rounded">
              {error}
            </div>
          ) : null,
          report ? (
            <pre key="rep" className="mt-4 p-4 bg-gray-50 text-gray-800 rounded overflow-auto max-w-xl">
              {JSON.stringify(report, null, 2)}
            </pre>
          ) : null
        ]}
      </div>
    </div>
  );
}

export default ReportPage;