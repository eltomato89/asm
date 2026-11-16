// Local mirror of the push/approve API contract; replaced by the shared schemas from @asm/shared at merge.

export type PushSubscriptionDto = { id: string; deviceName: string; createdAt: number; lastUsedAt: number | null };

export type PushSubscriptionInput = {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  deviceName: string;
};

export type ApproveMetaDiff = Record<string, { from: unknown; to: unknown }>;

export type ApproveSummaryDto = {
  kind: 'read' | 'update';
  device: { name: string };
  secret: { title: string; envName: string | null };
  project: string;
  reason: string;
  delivery: 'cli' | 'plaintext' | null;
  metaDiff?: ApproveMetaDiff;
  valueChanged?: boolean;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
};
