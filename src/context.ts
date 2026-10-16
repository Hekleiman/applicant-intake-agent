// App-wide run context: one object created at startup and passed to every run.

export type AuditEntry = {
  at: string; // ISO timestamp
  applicantId: string;
  action: 'approved' | 'declined' | 'executed';
  reason: string;
};

export type AppContext = { audit: AuditEntry[] };

export const auditEntry = (
  applicantId: string,
  action: AuditEntry['action'],
  reason: string,
): AuditEntry => ({ at: new Date().toISOString(), applicantId, action, reason });
