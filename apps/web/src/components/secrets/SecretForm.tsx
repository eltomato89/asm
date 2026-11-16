import type { SecretMeta, VaultDto } from '@asm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, queryKeys, type SecretWrite } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { GENERATE_ALPHABETS, parseTags, validateSecretForm, type Alphabet, type SecretFormErrors, type SecretFormValues } from '../../lib/validation';
import { Button } from '../ui/Button';
import { FieldError, Select, Switch, Textarea } from '../ui/Field';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

const ALPHABET_LABELS: Record<Alphabet, string> = {
  alnum: 'Buchstaben und Ziffern',
  hex: 'Hexadezimal',
  base64url: 'Base64 (URL-sicher)',
  symbols: 'Mit Sonderzeichen',
};

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

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Create/edit form for a secret; mirrors the server's validation rules. The value lives only in this form's state. */
export function SecretForm({ secret, vaults, defaultVaultId, onDone, onCancel }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
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

  const save = useMutation({
    mutationFn: (b: SecretWrite) => (secret ? api.updateSecret(secret.id, b) : api.createSecret({ ...b, title: b.title ?? '', vaultId })),
    onSuccess: (meta) => {
      qc.setQueryData(queryKeys.secret(meta.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(creating ? `${meta.envName ?? meta.title} angelegt.` : 'Änderungen gespeichert.', 'ok');
      onDone(meta);
    },
    onError: (e) => toast(errorText(e, creating ? 'Anlegen fehlgeschlagen.' : 'Speichern fehlgeschlagen.'), 'danger'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateSecretForm(v, { creating });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const b = body();
    if (!creating && Object.keys(b).length === 0) {
      toast('Keine Änderungen zum Speichern.');
      return;
    }
    save.mutate(b);
  };

  const modes: { mode: SecretFormValues['valueMode']; label: string }[] = creating
    ? [
        { mode: 'enter', label: 'Eingeben' },
        { mode: 'generate', label: 'Generieren' },
      ]
    : [
        { mode: 'keep', label: 'Behalten' },
        { mode: 'enter', label: 'Neu eingeben' },
        { mode: 'generate', label: 'Generieren' },
      ];

  return (
    <form className="secret-form" onSubmit={submit} noValidate aria-label={creating ? 'Secret anlegen' : 'Secret bearbeiten'}>
      {creating && vaults.length > 1 ? (
        <Select label="Tresor" value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
          {vaults.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      ) : null}
      <Input label="Titel" value={v.title} maxLength={200} onChange={(e) => set('title', e.target.value)} aria-invalid={!!errors.title} />
      <FieldError>{errors.title}</FieldError>
      <Input
        label="ENV-Name"
        mono
        placeholder="GITHUB_TOKEN"
        autoComplete="off"
        spellCheck={false}
        value={v.envName}
        onChange={(e) => set('envName', e.target.value.toUpperCase())}
        aria-invalid={!!errors.envName}
        help={errors.envName ? undefined : 'Optional. Unter diesem Namen landet der Wert in .env-Dateien.'}
      />
      <FieldError>{errors.envName}</FieldError>
      <Textarea label="Beschreibung" rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} error={errors.description} help="Hilft Agents, das richtige Secret zu finden. Nie den Wert hier eintragen." />
      <Input label="Tags" mono placeholder="ci prod" value={v.tags} onChange={(e) => set('tags', e.target.value)} aria-invalid={!!errors.tags} help={errors.tags ? undefined : 'Mit Leerzeichen oder Komma getrennt.'} />
      <FieldError>{errors.tags}</FieldError>

      <fieldset className="field value-field">
        <legend>Wert</legend>
        <div className="seg" role="group" aria-label="Wert">
          {modes.map((m) => (
            <button key={m.mode} type="button" aria-pressed={v.valueMode === m.mode} onClick={() => set('valueMode', m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
        {v.valueMode === 'enter' ? (
          <Textarea
            label={creating ? 'Wert eingeben' : 'Neuer Wert'}
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
            <Input label="Länge" type="number" min={16} max={256} mono value={String(v.length)} onChange={(e) => set('length', Number(e.target.value))} aria-invalid={!!errors.length} />
            <Select label="Zeichen" value={v.alphabet} onChange={(e) => set('alphabet', e.target.value as Alphabet)}>
              {GENERATE_ALPHABETS.map((a) => (
                <option key={a} value={a}>
                  {ALPHABET_LABELS[a]}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <FieldError>{errors.length}</FieldError>
        {v.valueMode === 'generate' ? <p className="help">Der Server erzeugt den Wert zufällig. Du kannst ihn danach anzeigen.</p> : null}
      </fieldset>

      <div className="field">
        <Switch checked={v.allowPlaintextToAgent} onChange={(x) => set('allowPlaintextToAgent', x)} label="Klartext an Agenten erlauben" />
        <p className={v.allowPlaintextToAgent ? 'help warn' : 'help'}>
          {v.allowPlaintextToAgent
            ? 'Agents dürfen den Wert dann direkt im Gesprächsverlauf erhalten. Er kann so in Protokollen und beim Modellanbieter landen. Nur für unkritische Werte.'
            : 'Standard: Agents erhalten den Wert nur über die CLI-Übergabe, nie im Gesprächsverlauf.'}
        </p>
      </div>

      <div className="form-actions">
        <Button onClick={onCancel}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {creating ? 'Secret anlegen' : 'Änderungen speichern'}
        </Button>
      </div>
    </form>
  );
}
