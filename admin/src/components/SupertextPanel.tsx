import * as React from 'react';
import { useIntl } from 'react-intl';
import { Box, Button, Checkbox, Divider, Flex, Radio, Typography } from '@strapi/design-system';
import { useFetchClient, useNotification, useQueryParams } from '@strapi/strapi/admin';
import { apiError, type ImportResult, type LocaleResult, type PluginStatus, type StrapiLocale } from '../api';
import { PLUGIN_ID } from '../pluginId';
import { errorText } from '../utils/errorText';
import { getTranslation } from '../utils/getTranslation';

interface PanelProps {
  model: string;
  documentId?: string;
  document?: { locale?: string; documentId?: string; [key: string]: unknown };
  meta?: { availableLocales?: Array<{ locale: string }> };
  collectionType: string;
}

/**
 * Edit-view side panel: pick target locales and translate the current entry
 * with Supertext. Hidden for content types without i18n and for unsaved entries.
 */
const SupertextPanel = (props: PanelProps) => {
  const { formatMessage } = useIntl();
  const { document, meta } = props;
  const documentId = props.documentId ?? document?.documentId;
  const isLocalized = Boolean(document?.locale);

  if (!isLocalized || !documentId) {
    return null;
  }

  return {
    title: formatMessage({ id: getTranslation('panel.title'), defaultMessage: 'Supertext translation' }),
    content: (
      <PanelContent
        model={props.model}
        documentId={documentId}
        sourceLocale={document!.locale as string}
        existing={(meta?.availableLocales ?? []).map((l) => l.locale)}
      />
    ),
  };
};

interface PanelContentProps {
  model: string;
  documentId: string;
  sourceLocale: string;
  existing: string[];
}

const PanelContent = ({ model, documentId, sourceLocale, existing }: PanelContentProps) => {
  const { formatMessage } = useIntl();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [{ query }, setQuery] = useQueryParams<{ plugins?: Record<string, unknown> }>();

  const [locales, setLocales] = React.useState<StrapiLocale[]>([]);
  const [status, setStatus] = React.useState<PluginStatus | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<LocaleResult[]>([]);
  const [created, setCreated] = React.useState<string[]>([]);
  const [format, setFormat] = React.useState<'xliff' | 'html'>('xliff');
  const [file, setFile] = React.useState<File | null>(null);
  const [includeChanged, setIncludeChanged] = React.useState(false);
  const [imports, setImports] = React.useState<ImportResult[] | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([get<StrapiLocale[]>('/i18n/locales'), get<PluginStatus>(`/${PLUGIN_ID}/status`)])
      .then(([l, s]) => {
        if (!cancelled) {
          setLocales(l.data);
          setStatus(s.data);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [get]);

  // Reset when switching entry or locale.
  React.useEffect(() => {
    setSelected([]);
    setResults([]);
    setCreated([]);
    setImports(null);
  }, [documentId, sourceLocale]);

  const targets = locales.filter((locale) => locale.code !== sourceLocale);
  const exists = (code: string) => existing.includes(code) || created.includes(code);
  const name = (code: string) => locales.find((l) => l.code === code)?.name ?? code;
  const resultError = (result: LocaleResult) =>
    errorText(formatMessage, { message: result.error ?? '', code: result.code, values: result.values });

  if (!targets.length) {
    return (
      <Typography variant="pi" textColor="neutral600">
        {formatMessage({
          id: getTranslation('panel.noLocales'),
          defaultMessage: 'Add more locales under Settings → Internationalization to translate this entry.',
        })}
      </Typography>
    );
  }

  const toggle = (code: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, code] : current.filter((c) => c !== code)));

  const translate = async () => {
    setBusy(true);
    setResults([]);
    try {
      const { data } = await post<{ results: LocaleResult[] }>(`/${PLUGIN_ID}/translate`, {
        model,
        documentId,
        sourceLocale,
        targetLocales: selected,
      });
      setResults(data.results);
      const ok = data.results.filter((r) => r.status !== 'error');
      const failed = data.results.filter((r) => r.status === 'error');
      setCreated((current) => [...current, ...ok.map((r) => r.locale)]);
      setSelected([]);
      if (ok.length) {
        toggleNotification({
          type: 'success',
          message: formatMessage(
            { id: getTranslation('panel.success'), defaultMessage: 'Translated into {locales}.' },
            { locales: ok.map((r) => name(r.locale)).join(', ') }
          ),
        });
      }
      if (failed.length) {
        toggleNotification({
          type: 'danger',
          message: failed.map((r) => `${name(r.locale)}: ${resultError(r)}`).join(' · '),
        });
      }
    } catch (error) {
      toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) });
    } finally {
      setBusy(false);
    }
  };

  const open = (code: string) =>
    setQuery({ plugins: { ...(query.plugins ?? {}), i18n: { locale: code } } }, 'push', true);

  const overwriting = selected.filter(exists);
  const configured = !status || status.configured;
  const htmlInvalid = format === 'html' && selected.length !== 1;

  /** Export for translation: GET /supertext/export as a file download (no API key needed). */
  const exportFile = async () => {
    setBusy(true);
    try {
      const response = await get<Blob>(`/${PLUGIN_ID}/export`, {
        params: { model, documentId, sourceLocale, targetLocales: selected.join(','), format },
        responseType: 'blob',
        validateStatus: () => true,
      } as never);
      const blob = response.data as unknown as Blob;
      if (response.status !== 200) {
        const body = JSON.parse(await blob.text()) as { error?: { message?: string; details?: { code?: string; values?: Record<string, string | number> } } };
        toggleNotification({
          type: 'danger',
          message: errorText(formatMessage, {
            message: body.error?.message ?? `HTTP ${response.status}`,
            code: body.error?.details?.code,
            values: body.error?.details?.values,
          }),
        });
        return;
      }
      const suffix = selected.length === 1 ? `-${selected[0]}` : '';
      const name = `strapi-${model.split('.').pop()}-${documentId}${suffix}.${format === 'html' ? 'html' : 'xlf'}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = name;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) });
    } finally {
      setBusy(false);
    }
  };

  /** Import translation: multipart upload to POST /supertext/import, then the summary per job. */
  const importFile = async () => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toggleNotification({
        type: 'danger',
        message: formatMessage({ id: getTranslation('error.fileTooLarge'), defaultMessage: 'The file is too large (at most 10 MB).' }),
      });
      return;
    }
    setBusy(true);
    setImports(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('includeChanged', includeChanged ? '1' : '0');
      const { data } = await post<{ results: ImportResult[] }>(`/${PLUGIN_ID}/import`, form);
      setImports(data.results);
      setCreated((current) => [...current, ...data.results.filter((r) => (r.imported ?? 0) > 0).map((r) => r.targetLocale)]);
    } catch (error) {
      toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) });
    } finally {
      setBusy(false);
    }
  };

  const t = (id: string, defaultMessage: string, values?: Record<string, string | number>) =>
    formatMessage({ id: getTranslation(id), defaultMessage }, values);

  return (
    <Flex direction="column" alignItems="stretch" gap={3} width="100%">
      <Typography variant="pi" textColor="neutral600">
        {formatMessage(
          {
            id: getTranslation('panel.intro'),
            defaultMessage: 'Translate the saved {locale} version into:',
          },
          { locale: name(sourceLocale) }
        )}
      </Typography>

      <Flex direction="column" alignItems="flex-start" gap={2}>
        {targets.map((locale) => (
          <Checkbox
            key={locale.code}
            checked={selected.includes(locale.code)}
            onCheckedChange={(checked: boolean | 'indeterminate') => toggle(locale.code, checked === true)}
            disabled={busy}
          >
            {locale.name}
            {exists(locale.code) ? (
              <Typography variant="pi" textColor="neutral500">
                {' '}
                {formatMessage({ id: getTranslation('panel.exists'), defaultMessage: '(exists)' })}
              </Typography>
            ) : null}
          </Checkbox>
        ))}
      </Flex>

      {overwriting.length ? (
        <Typography variant="pi" textColor="warning600">
          {formatMessage(
            {
              id: getTranslation('panel.overwrite'),
              defaultMessage: 'Existing translations will be replaced: {locales}',
            },
            { locales: overwriting.map(name).join(', ') }
          )}
        </Typography>
      ) : null}

      {configured ? (
        <Button fullWidth onClick={translate} loading={busy} disabled={!selected.length || busy} variant="secondary">
          {formatMessage({ id: getTranslation('panel.button'), defaultMessage: 'Translate with Supertext' })}
        </Button>
      ) : (
        <Typography variant="pi" textColor="neutral600">
          {formatMessage({
            id: getTranslation('panel.notConfigured'),
            defaultMessage: 'Supertext is not configured yet. Ask an administrator to set the API key.',
          })}
        </Typography>
      )}

      {results.length ? (
        <Box>
          {results.map((result) => (
            <Flex key={result.locale} justifyContent="space-between" gap={2} paddingTop={1}>
              <Typography variant="pi" textColor={result.status === 'error' ? 'danger600' : 'success600'}>
                {name(result.locale)}:{' '}
                {result.status === 'error'
                  ? resultError(result)
                  : formatMessage(
                      { id: getTranslation(`panel.result.${result.status}`), defaultMessage: result.status },
                      { fields: result.fields }
                    )}
              </Typography>
              {result.status !== 'error' ? (
                <Button size="S" variant="ghost" onClick={() => open(result.locale)}>
                  {formatMessage({ id: getTranslation('panel.open'), defaultMessage: 'Open' })}
                </Button>
              ) : null}
            </Flex>
          ))}
        </Box>
      ) : null}

      <Divider />
      <Typography variant="sigma" textColor="neutral600">
        {t('panel.export.title', 'Export for translation')}
      </Typography>
      <Box>
        <Typography variant="pi" fontWeight="bold">
          {t('panel.export.format', 'File format')}
        </Typography>
        <Radio.Group
          aria-label={t('panel.export.format', 'File format')}
          value={format}
          onValueChange={(value: string) => setFormat(value === 'html' ? 'html' : 'xliff')}
        >
          <Radio.Item value="xliff">{t('panel.export.xliff', 'XLIFF 1.2 (for translation tools)')}</Radio.Item>
          <Radio.Item value="html">{t('panel.export.html', 'HTML (one language per file)')}</Radio.Item>
        </Radio.Group>
      </Box>
      {htmlInvalid && selected.length > 1 ? (
        <Typography variant="pi" textColor="warning600">
          {t('panel.export.oneLanguage', 'Choose exactly one language for an HTML file.')}
        </Typography>
      ) : null}
      <Button fullWidth onClick={exportFile} disabled={!selected.length || htmlInvalid || busy} variant="tertiary">
        {t('panel.export.download', 'Download file')}
      </Button>

      <Divider />
      <Typography variant="sigma" textColor="neutral600">
        {t('panel.import.title', 'Import translation')}
      </Typography>
      <Flex direction="column" alignItems="stretch" gap={2}>
        <label>
          <Typography variant="pi" fontWeight="bold">
            {t('panel.import.file', 'Translated file (XLIFF or HTML)')}
          </Typography>
          <input
            ref={fileInput}
            type="file"
            accept=".xlf,.xliff,.html,.htm,application/x-xliff+xml,text/html"
            disabled={busy}
            style={{ display: 'block', marginTop: 4, maxWidth: '100%' }}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setImports(null);
            }}
          />
        </label>
        <Checkbox checked={includeChanged} onCheckedChange={(checked: boolean | 'indeterminate') => setIncludeChanged(checked === true)} disabled={busy}>
          {t('panel.import.includeChanged', 'Also import texts whose source changed since the export')}
        </Checkbox>
        <Button fullWidth onClick={importFile} disabled={!file || busy} loading={busy && Boolean(file)} variant="tertiary">
          {t('panel.import.button', 'Import translation')}
        </Button>
      </Flex>
      {imports ? (
        <Box aria-live="polite">
          {imports.map((job, index) => (
            <Box key={index} paddingTop={2}>
              <Flex justifyContent="space-between" gap={2}>
                <Typography variant="pi" fontWeight="bold">
                  {name(job.targetLocale)}
                  {job.documentId && job.documentId !== documentId ? ` (${job.documentId})` : ''}
                </Typography>
                {(job.imported ?? 0) > 0 ? (
                  <Button size="S" variant="ghost" onClick={() => open(job.targetLocale)}>
                    {formatMessage({ id: getTranslation('panel.open'), defaultMessage: 'Open' })}
                  </Button>
                ) : null}
              </Flex>
              {job.error ? (
                <Typography variant="pi" textColor="danger600">
                  {errorText(formatMessage, { message: job.error, code: job.code, values: job.values })}
                </Typography>
              ) : (
                <Flex direction="column" alignItems="flex-start">
                  <Typography variant="pi" textColor="success600">
                    {t('panel.import.ok', 'Imported: {count}', { count: job.imported ?? 0 })}
                  </Typography>
                  {(job.sourceChanged ?? 0) > 0 ? (
                    <Typography variant="pi" textColor="warning600">
                      {t('panel.import.changed', 'Skipped, source changed since the export: {count}', { count: job.sourceChanged ?? 0 })}
                    </Typography>
                  ) : null}
                  {(job.untranslated ?? 0) > 0 ? (
                    <Typography variant="pi">
                      {t('panel.import.untranslated', 'Not translated in the file: {count}', { count: job.untranslated ?? 0 })}
                    </Typography>
                  ) : null}
                  {(job.invalid ?? 0) > 0 ? (
                    <Typography variant="pi" textColor="warning600">
                      {t('panel.import.invalid', 'Formatting changed, not imported: {count}', { count: job.invalid ?? 0 })}
                    </Typography>
                  ) : null}
                  {(job.missing ?? 0) > 0 ? (
                    <Typography variant="pi">
                      {t('panel.import.missing', 'Not in the file: {count}', { count: job.missing ?? 0 })}
                    </Typography>
                  ) : null}
                </Flex>
              )}
            </Box>
          ))}
        </Box>
      ) : null}
    </Flex>
  );
};

/** Same limit as the server, checked before the upload. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export { SupertextPanel };
