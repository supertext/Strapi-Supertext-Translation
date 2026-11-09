import * as React from 'react';
import { useIntl } from 'react-intl';
import {
  Box,
  Button,
  Checkbox,
  Flex,
  SingleSelect,
  SingleSelectOption,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { Page, useFetchClient, useNotification, useRBAC } from '@strapi/strapi/admin';
import { apiError, PERMISSIONS, type LanguageStatus, type Politeness, type SettingsPage, type TargetOption } from '../api';
import { PLUGIN_ID } from '../pluginId';
import { errorText } from '../utils/errorText';
import { getTranslation } from '../utils/getTranslation';

type Draft = Record<string, { code: string | null; politeness: Politeness; review: boolean }>;

/** The combo box's starting value: the saved code, else the SDK's suggestion (exact match or default), else empty. */
const initialDraft = (languages: LanguageStatus[]): Draft =>
  Object.fromEntries(
    languages.map((language) => [language.code, { code: language.saved ?? language.suggested, politeness: language.savedPoliteness, review: language.savedReview }])
  );

/** "German (Switzerland) (de-CH)", the name in the admin's language where the browser knows it. */
const optionLabel = (option: TargetOption, names: Intl.DisplayNames | null) => {
  let name = option.name;
  if (names && !option.code.includes('-u-')) {
    try {
      const localized = names.of(option.code);
      if (localized && localized.toLowerCase() !== option.code.toLowerCase()) name = localized;
    } catch {
      // Keep the SDK's English name.
    }
  }
  return `${name} (${option.code})`;
};

/**
 * Settings → Supertext → Translation → Languages: one combo box per Strapi locale (source
 * included: one mapping serves both directions), preselected with the saved code, else the
 * SDK's suggestion, and the Translation review checkbox. A locale set under `locales` in
 * config/plugins shows that value, read-only.
 */
export const LanguagesCard = () => {
  const { formatMessage, locale } = useIntl();
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { allowedActions, isLoading: loadingPermissions } = useRBAC({ update: PERMISSIONS.update });
  const canUpdate = Boolean(allowedActions.canUpdate);
  const [page, setPage] = React.useState<SettingsPage | null>(null);
  const [draft, setDraft] = React.useState<Draft>({});
  const [saving, setSaving] = React.useState(false);
  const t = (id: string, defaultMessage: string, values?: Record<string, string>) =>
    formatMessage({ id: getTranslation(id), defaultMessage }, values);

  const load = React.useCallback(
    (data: SettingsPage) => {
      setPage(data);
      setDraft(initialDraft(data.languages));
    },
    [setPage, setDraft]
  );

  React.useEffect(() => {
    get<SettingsPage>(`/${PLUGIN_ID}/settings`)
      .then(({ data }) => load(data))
      .catch((error) => toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) }));
  }, [get, load, toggleNotification, formatMessage]);

  const names = React.useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' });
    } catch {
      return null;
    }
  }, [locale]);

  const options = React.useMemo(
    () =>
      (page?.targets ?? [])
        .map((option) => ({ ...option, label: optionLabel(option, names) }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [page, names, locale]
  );
  const byCode = React.useMemo(() => new Map(options.map((option) => [option.code, option])), [options]);

  if (!page || loadingPermissions) {
    return <Page.Loading />;
  }

  const setCode = (language: string, code: string | null) =>
    setDraft((current) => {
      const politeness = code && byCode.get(code)?.politeness ? current[language]?.politeness ?? 'default' : 'default';
      return { ...current, [language]: { code, politeness, review: current[language]?.review ?? false } };
    });
  const setPoliteness = (language: string, politeness: Politeness) =>
    setDraft((current) => ({
      ...current,
      [language]: { code: current[language]?.code ?? null, politeness, review: current[language]?.review ?? false },
    }));
  const setReview = (language: string, review: boolean) =>
    setDraft((current) => ({
      ...current,
      [language]: { code: current[language]?.code ?? null, politeness: current[language]?.politeness ?? 'default', review },
    }));

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await put<SettingsPage>(`/${PLUGIN_ID}/settings`, { languages: draft });
      load(data);
      toggleNotification({ type: 'success', message: t('settings.languages.saved', 'Language settings saved.') });
    } catch (error) {
      toggleNotification({ type: 'danger', message: errorText(formatMessage, apiError(error)) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box background="neutral0" hasRadius shadow="filterShadow" padding={6}>
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Flex justifyContent="space-between" alignItems="center">
          <Typography variant="delta" tag="h2">
            {t('settings.languages', 'Languages')}
          </Typography>
          <Button onClick={save} loading={saving} disabled={!canUpdate || !page.languages.length}>
            {t('settings.save', 'Save')}
          </Button>
        </Flex>
        <Typography variant="pi" textColor="neutral600">
          {t(
            'settings.languages.help',
            'Choose the Supertext language for each Strapi locale. The same choice is used when the locale is the source. A locale nobody chose uses the preselected default (de → German (Germany), en → English (United States)); a locale without a default needs a choice before it can be translated.'
          )}
        </Typography>
        {page.languages.length === 0 ? (
          <Typography>{t('settings.languages.none', 'No locales yet. Add them under Settings → Internationalization.')}</Typography>
        ) : (
          <Table colCount={4} rowCount={page.languages.length + 1}>
            <Thead>
              <Tr>
                <Th><Typography variant="sigma">{t('settings.col.locale', 'Strapi locale')}</Typography></Th>
                <Th><Typography variant="sigma">{t('settings.col.code', 'Supertext language')}</Typography></Th>
                <Th><Typography variant="sigma">{t('settings.col.politeness', 'Politeness')}</Typography></Th>
                <Th><Typography variant="sigma">{t('settings.col.review', 'Translation review')}</Typography></Th>
              </Tr>
            </Thead>
            <Tbody>
              {page.languages.map((language) => {
                const row = draft[language.code] ?? { code: null, politeness: 'default' as Politeness, review: false };
                const reviewOverridden = language.override.review !== undefined;
                const review = language.override.review ?? row.review;
                const overridden = Boolean(language.override.code);
                const code = language.override.code ?? row.code;
                const target = code ? byCode.get(code) : undefined;
                const politenessOverridden = Boolean(language.override.politeness);
                const politeness = language.override.politeness ?? row.politeness;
                const label = t('settings.col.codeFor', 'Supertext language for {locale}', { locale: language.name });
                return (
                  <Tr key={language.code}>
                    <Td>
                      <Flex direction="column" alignItems="flex-start">
                        <Typography>{language.name}</Typography>
                        {!language.name.includes(language.code) && (
                          <Typography variant="pi" textColor="neutral600">{language.code}</Typography>
                        )}
                      </Flex>
                    </Td>
                    <Td>
                      <Flex direction="column" alignItems="stretch" gap={1} minWidth="18rem">
                        <SingleSelect
                          aria-label={label}
                          placeholder={t('settings.choose', '— choose —')}
                          value={code ?? null}
                          disabled={!canUpdate || overridden}
                          onChange={(value: string | number) => setCode(language.code, String(value))}
                          onClear={
                            overridden || !row.code || row.code === language.suggested
                              ? undefined
                              : () => setCode(language.code, language.suggested)
                          }
                          clearLabel={t('settings.clear', 'Reset to the default')}
                          hasError={!code}
                        >
                          {/* A configured code the SDK doesn't list is still shown (and sent as it is). */}
                          {code && !target && <SingleSelectOption value={code}>{code}</SingleSelectOption>}
                          {options.map((option) => (
                            <SingleSelectOption key={option.code} value={option.code}>
                              {option.label}
                            </SingleSelectOption>
                          ))}
                        </SingleSelect>
                        {overridden ? (
                          <Typography variant="pi" textColor="neutral600">
                            {t('settings.override', 'Set in config/plugins (locales.{locale}), which wins over this choice.', {
                              locale: language.code,
                            })}
                          </Typography>
                        ) : !code ? (
                          <Typography variant="pi" textColor="danger600">
                            {t('settings.noDefault', 'No default for this locale: choose its Supertext language, otherwise it can’t be translated.')}
                          </Typography>
                        ) : null}
                      </Flex>
                    </Td>
                    <Td>
                      {target?.politeness || politeness !== 'default' ? (
                        <Flex direction="column" alignItems="stretch" gap={1} minWidth="10rem">
                          <SingleSelect
                            aria-label={t('settings.col.politenessFor', 'Politeness for {locale}', { locale: language.name })}
                            value={politeness}
                            disabled={!canUpdate || politenessOverridden}
                            onChange={(value: string | number) => setPoliteness(language.code, String(value) as Politeness)}
                          >
                            <SingleSelectOption value="default">{t('settings.politeness.default', 'Default')}</SingleSelectOption>
                            <SingleSelectOption value="more">{t('settings.formal', 'Formal')}</SingleSelectOption>
                            <SingleSelectOption value="less">{t('settings.informal', 'Informal')}</SingleSelectOption>
                          </SingleSelect>
                          {target && !target.politeness && politeness !== 'default' && (
                            <Typography textColor="danger600" variant="pi">
                              {t('settings.noPoliteness', 'Supertext offers no formal/informal choice for this language')}
                            </Typography>
                          )}
                        </Flex>
                      ) : (
                        <Typography textColor="neutral600">–</Typography>
                      )}
                    </Td>
                    <Td>
                      <Flex direction="column" alignItems="flex-start" gap={1}>
                        <Checkbox
                          aria-label={t('settings.col.reviewFor', 'Translation review for {locale}', { locale: language.name })}
                          checked={review && page.reviewAvailable}
                          disabled={!canUpdate || reviewOverridden || !page.reviewAvailable}
                          onCheckedChange={(checked: boolean | 'indeterminate') => setReview(language.code, checked === true)}
                        />
                        {reviewOverridden && page.reviewAvailable && (
                          <Typography variant="pi" textColor="neutral600">
                            {t('settings.override', 'Set in config/plugins (locales.{locale}), which wins over this choice.', {
                              locale: language.code,
                            })}
                          </Typography>
                        )}
                      </Flex>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
        <Typography variant="pi" textColor="neutral600">
          {page.reviewAvailable
            ? t(
                'settings.review.help',
                'Translation review: translations into this locale go through Supertext’s review service, so reviewers can check and correct them on the website with the Supertext Localization Review extension. Their corrections are used the next time the entry is translated.'
              )
            : t('settings.review.off', 'Translation review is turned off for every locale (reviewUrl is empty in config/plugins).')}
        </Typography>
        <Typography variant="pi" textColor="neutral600">
          {t(
            'settings.languages.overrideHelp',
            'For automated setups, code, politeness and review under locales in config/plugins override this page per locale.'
          )}
        </Typography>
      </Flex>
    </Box>
  );
};
