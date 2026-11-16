import type { AccessRequestDto } from '@asm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, queryKeys } from '../../lib/api';
import { decisionErrorText } from '../../lib/errors';
import { useShortcut } from '../../lib/shortcuts';
import { useNow } from '../../lib/time';
import { useToast } from '../ui/Toast';
import { RequestCard, type Decision } from './RequestCard';

/**
 * Pending requests as cards. J/K move the focus, A approves and D denies the focused card.
 * There is no server-side undo, so a decision ends with a plain result toast.
 */
export function RequestQueue({ requests }: { requests: AccessRequestDto[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(1000, requests.length > 0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Record<string, Decision>>({});
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const visible = requests.filter((r) => r.status === 'pending');
  const focused = visible.find((r) => r.id === focusId);
  const focusIndex = focused ? visible.indexOf(focused) : -1;
  const autoFocused = useRef(false);

  // The first card is focused once on arrival. If the focused card disappears (decided elsewhere, expired),
  // the focus is cleared instead of jumping to another card: A/D then need an explicit J/K or click first.
  useEffect(() => {
    if (!autoFocused.current && visible[0]) {
      autoFocused.current = true;
      setFocusId(visible[0].id);
    } else if (focusId !== null && !focused) {
      setFocusId(null);
    }
  }, [visible, focusId, focused]);

  const decide = useMutation({
    mutationFn: ({ request, decision }: { request: AccessRequestDto; decision: Decision }) => api.decide(request.id, decision),
    onMutate: ({ request, decision }) => setLeaving((m) => ({ ...m, [request.id]: decision })),
    onSuccess: (_dto, { request, decision }) => {
      const name = request.secret.envName ?? request.secret.title;
      toast(
        <>
          {decision === 'approve' ? 'Freigegeben' : 'Verweigert'}: <span className="mono">{name}</span> für {request.device.name}
        </>,
        decision === 'approve' ? 'ok' : 'danger',
      );
    },
    onError: (e, { request }) => {
      setLeaving(({ [request.id]: _, ...rest }) => rest);
      toast(decisionErrorText(e), 'danger');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.requestsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });

  const decideOn = (decision: Decision, request = focused) => {
    if (!request || leaving[request.id] || decide.isPending) return;
    decide.mutate({ request, decision });
    // Hand the keyboard focus to the next open card right away.
    if (request.id === focused?.id) {
      const i = visible.indexOf(request);
      const next = visible.slice(i + 1).find((r) => !leaving[r.id]) ?? visible.slice(0, i).reverse().find((r) => !leaving[r.id]);
      if (next) setFocusId(next.id);
    }
  };
  const move = (delta: number) => {
    const next = focusIndex < 0 ? visible[0] : visible[Math.min(visible.length - 1, Math.max(0, focusIndex + delta))];
    if (!next) return;
    setFocusId(next.id);
    cardRefs.current.get(next.id)?.scrollIntoView({ block: 'nearest' });
  };

  const enabled = visible.length > 0;
  useShortcut('a', () => decideOn('approve'), { enabled });
  useShortcut('d', () => decideOn('deny'), { enabled });
  useShortcut('j', () => move(1), { enabled });
  useShortcut('k', () => move(-1), { enabled });

  return (
    <div className="requests" aria-live="polite">
      {visible.map((r) => (
        <RequestCard
          key={r.id}
          ref={(el) => {
            if (el) cardRefs.current.set(r.id, el);
            else cardRefs.current.delete(r.id);
          }}
          request={r}
          now={now}
          focused={r.id === focused?.id}
          leaving={leaving[r.id] ?? null}
          busy={decide.isPending}
          onFocus={() => setFocusId(r.id)}
          onDecide={(d) => decideOn(d, r)}
        />
      ))}
      {visible.length === 0 ? (
        <div className="empty">
          <strong>Keine offenen Anfragen</strong>
          Neue Anfragen von Agents erscheinen hier, sobald sie eintreffen.
        </div>
      ) : null}
    </div>
  );
}
