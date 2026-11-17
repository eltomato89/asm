import type { SecretMeta, VaultDto } from '@asm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { t } from '../../i18n';
import { api, queryKeys, type SecretWrite } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { GENERATE_ALPHABETS, parseTags, validateSecretForm, type Alphabet, type SecretFormErrors, type SecretFormValues } from '../../lib/validation';
import { vaultLabel } from '../../lib/vault';
import { Button } from '../ui/Button';
import { FieldError, Select, Switch, Textarea } from '../ui/Field';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

type Props = {
  /** Existing secret (edit) or undefined (create). */
  secret?: SecretMeta;
  vaults: VaultDto[];
  defaultVaultId?: string;
  onDone: (meta: SecretMeta) => void;
  onCancel: () => void;
};

function initial(secret?: SecretMeta): SecretFormValues {
  return {
    title: secret?.title ?? '',
    description: secret?.description ?? '',
    tags: secret?.tags.join(' ') ?? '',
    envName: secret?.envName ?? '',
    allowPlaintextToAgent: secret?.allowPlaintextToAgent ?? false,
    valueMode: secret ? 'keep' : 'enter',
    value: '',
    length: 32,
    alphabet: 'alnum',
  };
}

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((tag, i) => tag === b[i]);

/** Create/edit form for a secret; mirrors the server's validation rules. The value lives only in this form's state. */
export function SecretForm({ secret, vaults, defaultVaultId, onDone, onCancel }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = t.secrets.form;
  const creating = !secret;
  const [v, setV] = useState<SecretFormValues>(() => initial(secret));
  const [vaultId, setVaultId] = useState(defaultVaultId ?? vaults[0]?.id ?? '');
  const [errors, setErrors] = useState<SecretFormErrors>({});
  const set = <K extends keyof SecretFormValues>(k: K, val: SecretFormValues[K]) => setV((s) => ({ ...s, [k]: val }));

  const body = (): SecretWrite => {
    const tags = parseTags(v.tags);
    const envName = v.envName.trim() || null;
    const out: SecretWrite = {};
    if (!secret || v.title.trim() !== secret.title) out.title = v.title.trim();
    if (!secret || v.description !== secret.description) out.description = v.description;
    if (!secret || !sameTags(tags, secret.tags)) out.tags = tags;
    if (!secret || envName !== secret.envName) out.envName = envName;
    if (!secret || v.allowPlaintextToAgent !== secret.allowPlaintextToAgent) out.allowPlaintextToAgent = v.allowPlaintextToAgent;
    if (v.valueMode === 'enter') out.value = v.value;
    if (v.valueMode === 'generate') out.generate = { length: v.length, alphabet: v.alphabet };
    return out;
  };

  // Deliberately no useMutation: its cache would keep the request body (incl. the value) as variables.
  const [saving, setSaving] = useState(false);
  const save = async (b: SecretWrite) => {
    setSaving(true);
    try {
      const meta = secret ? await api.updateSecret(secret.id, b) : await api.createSecret({ ...b, title: b.title ?? '', vaultId });
      qc.setQueryData(queryKeys.secret(meta.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(creating ? m.created(meta.envName ?? meta.title) : m.saved, 'ok');
      onDone(meta);
    } catch (e) {
      toast(errorText(e, creating ? m.createFailed : m.saveFailed), 'danger');
      setSaving(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateSecretForm(v, { creating });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const b = body();
    if (!creating && Object.keys(b).length === 0) {
      toast(m.noChanges);
      return;
    }
    void save(b);
  };

  const modes: { mode: SecretFormValues['valueMode']; label: string }[] = creating
    ? [
        { mode: 'enter', label: m.modes.enter },
        { mode: 'generate', label: m.modes.generate },
      ]
    : [
        { mode: 'keep', label: m.modes.keep },
        { mode: 'enter', label: m.modes.enterNew },
        { mode: 'generate', label: m.modes.generate },
      ];

  return (
    <form className="secret-form" onSubmit={submit} noValidate aria-label={creating ? m.createLabel : m.editLabel}>
      {creating && vaults.length > 1 ? (
        <Select label={m.vault} value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
          {vaults.map((x) => (
            <option key={x.id} value={x.id}>
              {vaultLabel(x)}
            </option>
          ))}
        </Select>
      ) : null}
      <Input label={m.title} value={v.title} maxLength={200} onChange={(e) => set('title', e.target.value)} aria-invalid={!!errors.title} />
      <FieldError>{errors.title}</FieldError>
      <Input
        label={m.envName}
        mono
        placeholder="GITHUB_TOKEN"
        autoComplete="off"
        spellCheck={false}
        value={v.envName}
        onChange={(e) => set('envName', e.target.value.toUpperCase())}
        aria-invalid={!!errors.envName}
        help={errors.envName ? undefined : m.envNameHelp}
      />
      <FieldError>{errors.envName}</FieldError>
      <Textarea label={m.description} rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} error={errors.description} help={m.descriptionHelp} />
      <Input label={m.tags} mono placeholder="ci prod" value={v.tags} onChange={(e) => set('tags', e.target.value)} aria-invalid={!!errors.tags} help={errors.tags ? undefined : m.tagsHelp} />
      <FieldError>{errors.tags}</FieldError>

      <fieldset className="field value-field">
        <legend>{m.value}</legend>
        <div className="seg" role="group" aria-label={m.value}>
          {modes.map((m) => (
            <button key={m.mode} type="button" aria-pressed={v.valueMode === m.mode} onClick={() => set('valueMode', m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
        {v.valueMode === 'enter' ? (
          <Textarea
            label={creating ? m.enterValue : m.newValue}
            className="mono-area"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={v.value}
            onChange={(e) => set('value', e.target.value)}
            error={errors.value}
          />
        ) : null}
        {v.valueMode === 'generate' ? (
          <div className="gen-row">
            <Input label={m.length} type="number" min={16} max={256} mono value={String(v.length)} onChange={(e) => set('length', Number(e.target.value))} aria-invalid={!!errors.length} />
            <Select label={m.characters} value={v.alphabet} onChange={(e) => set('alphabet', e.target.value as Alphabet)}>
              {GENERATE_ALPHABETS.map((a) => (
                <option key={a} value={a}>
                  {m.alphabets[a]}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <FieldError>{errors.length}</FieldError>
        {v.valueMode === 'generate' ? <p className="help">{m.generateHelp}</p> : null}
      </fieldset>

      <div className="field">
        <Switch checked={v.allowPlaintextToAgent} onChange={(x) => set('allowPlaintextToAgent', x)} label={m.allowPlaintext} />
        <p className={v.allowPlaintextToAgent ? 'help danger' : 'help'}>
          {v.allowPlaintextToAgent
            ? m.plaintextWarning
            : m.plaintextDefault}
        </p>
      </div>

      <div className="form-actions">
        <Button onClick={onCancel}>{t.common.cancel}</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {creating ? m.submitCreate : m.submitSave}
        </Button>
      </div>
    </form>
  );
}
