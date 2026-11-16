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
  const focusIndex = Math.max(0, visible.findIndex((r) => r.id === focusId));
  const focused = visible[focusIndex];

  // Keep the focus on a card that still exists.
  useEffect(() => {
    if (focused && focused.id !== focusId) setFocusId(focused.id);
  }, [focused, focusId]);

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
    const next = visible[Math.min(visible.length - 1, Math.max(0, focusIndex + delta))];
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
