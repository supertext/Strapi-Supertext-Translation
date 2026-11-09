import * as React from 'react';
import { useIntl } from 'react-intl';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';
import { apiError, type KeyCheck, type PluginStatus } from '../api';
import { PLUGIN_ID } from '../pluginId';
import { errorText } from '../utils/errorText';
import { getTranslation } from '../utils/getTranslation';
import { LanguagesCard } from '../components/LanguagesCard';

const SIGNUP_URL = 'https://www.supertext.com/person/en/account/signin';
const API_KEY_URL = 'https://www.supertext.com/en/integrations/api';
const RELEASES_URL = 'https://github.com/Supertext/Strapi-Supertext-Translation/releases/tag/';
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

const link = (href: string) => (chunks: React.ReactNode) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {chunks}
  </a>
);

/**
 * Settings → Supertext → Translation: whether an API key is set and the latest key check, which
 * endpoint is used, whether version information is sent (all from config/plugins and the
 * environment), and the language mapping, one combo box per Strapi locale (LanguagesCard).
 */
const Settings = () => {
  const { formatMessage, locale } = useIntl();
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [status, setStatus] = React.useState<PluginStatus | null>(null);
  const [check, setCheck] = React.useState<KeyCheck | null>(null);
  const [testing, setTesting] = React.useState(false);
  const t = (id: string, defaultMessage: string, values?: Record<string, string>) =>
    formatMessage({ id: getTranslation(id), defaultMessage }, values);

  React.useEffect(() => {
    get<PluginStatus>(`/${PLUGIN_ID}/status`).then(({ data }) => {
      setStatus(data);
      setCheck(data.reports?.check ?? null);
    });
  }, [get]);

  /** The key check in the user's language (texts from the Commando Center's guide). */
  const checkText = (c: KeyCheck) =>
    formatMessage(
      { id: getTranslation(`keycheck.${c.status}`), defaultMessage: c.status },
      { status: String(c.httpStatus ?? ''), signup: link(SIGNUP_URL), key: link(API_KEY_URL) }
    );
  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale);
  };

  const test = async () => {
    setTesting(true);
    try {
      const { data } = await post<{ ok: boolean; check: KeyCheck }>(`/${PLUGIN_ID}/test-connection`);
      setCheck(data.check);
    } catch (error) {
      toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) });
    } finally {
      setTesting(false);
    }
  };

  if (!status) {
    return <Page.Loading />;
  }

  return (
    <Layouts.Root>
      <Page.Title>Supertext</Page.Title>
      <Page.Main>
        <Layouts.Header
          title={t('settings.title', 'Supertext translation')}
          subtitle={t('settings.subtitle', 'Translate entries into other locales with Supertext AI.')}
          primaryAction={
            <Button onClick={test} loading={testing} disabled={!status.configured}>
              {t('settings.test', 'Test connection')}
            </Button>
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={6}>
            <Box background="neutral0" hasRadius shadow="filterShadow" padding={6}>
              <Flex direction="column" alignItems="flex-start" gap={2}>
                <Typography variant="delta" tag="h2">
                  {t('settings.connection', 'Connection')}
                </Typography>
                <Typography textColor={status.configured ? 'success600' : 'danger600'}>
                  {status.configured
                    ? t('settings.key.set', 'API key is set.')
                    : t('settings.key.missing', 'No API key. Set SUPERTEXT_API_KEY on the server and restart Strapi.')}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  {formatMessage(
                    {
                      id: getTranslation('settings.key.help'),
                      defaultMessage:
                        'No Supertext account yet? <signup>Create one at supertext.com</signup>. Generate your API key at <key>supertext.com → Integrations → API</key> (requires the Admin role).',
                    },
                    { signup: link(SIGNUP_URL), key: link(API_KEY_URL) }
                  )}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  {t('settings.endpoint', 'Endpoint: {endpoint}', { endpoint: status.endpoint })}
                </Typography>
                {status.version && (
                  <Typography variant="pi" textColor="neutral600">
                    {formatMessage(
                      { id: getTranslation('settings.version'), defaultMessage: 'Plugin version: {version}' },
                      {
                        version: RELEASE_VERSION.test(status.version) ? (
                          <a href={`${RELEASES_URL}v${status.version}`} target="_blank" rel="noopener noreferrer">
                            {status.version}
                          </a>
                        ) : (
                          status.version
                        ),
                      }
                    )}
                  </Typography>
                )}
                <Box paddingTop={3}>
                  <Typography variant="sigma" textColor="neutral600" tag="h3">
                    {t('settings.keyCheck', 'API key check')}
                  </Typography>
                </Box>
                {check ? (
                  <>
                    <Typography textColor={check.status === 'ok' ? 'success600' : 'danger600'}>{checkText(check)}</Typography>
                    <Typography variant="pi" textColor="neutral600">
                      {t('settings.keyCheck.at', 'Last checked: {time}', { time: when(check.checkedAt) })}
                    </Typography>
                  </>
                ) : (
                  <Typography variant="pi" textColor="neutral600">
                    {t('settings.keyCheck.none', 'Not checked yet.')}
                  </Typography>
                )}
              </Flex>
            </Box>

            <Box background="neutral0" hasRadius shadow="filterShadow" padding={6}>
              <Flex direction="column" alignItems="flex-start" gap={2}>
                <Typography variant="delta" tag="h2">
                  {t('settings.reports', 'Send version information to Supertext')}
                </Typography>
                <Typography textColor={status.reports?.enabled ? 'success600' : 'neutral800'}>
                  {status.reports?.enabled
                    ? t('settings.reports.on', 'On')
                    : t('settings.reports.off', 'Off (versionReports: false or SUPERTEXT_VERSION_REPORTS=0)')}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    'settings.reports.help',
                    'Sends the site URL and the versions of this plugin, Strapi and the runtime to Supertext after an update and when the API key changes, so Supertext support can see which version you run. No content, no API key and no personal data are sent. Turn it off with versionReports: false in config/plugins or SUPERTEXT_VERSION_REPORTS=0.'
                  )}
                </Typography>
              </Flex>
            </Box>

            <LanguagesCard />
          </Flex>
        </Layouts.Content>
      </Page.Main>
    </Layouts.Root>
  );
};

export default Settings;
