// Fake sample data for local development. Not real people.

export type Applicant = {
  id: string;
  name: string;
  role: string;
  stage: 'applied' | 'phone_screen' | 'interview_scheduled' | 'offer' | 'rejected';
  appliedOn: string;
  notes: string;
};

export const applicants: Applicant[] = [
  {
    id: 'A-1001',
    name: 'Maria Lopez',
    role: 'Executive Assistant',
    stage: 'phone_screen',
    appliedOn: '2026-09-22',
    notes: 'Strong calendar management background. Phone screen went well.',
  },
  {
    id: 'A-1002',
    name: 'Devon Park',
    role: 'Recruiter',
    stage: 'interview_scheduled',
    appliedOn: '2026-09-15',
    notes: 'Panel interview booked for next week.',
  },
  {
    id: 'A-1003',
    name: 'Priya Natarajan',
    role: 'Bookkeeper',
    stage: 'applied',
    appliedOn: '2026-10-08',
    notes: 'Resume received; not yet reviewed.',
  },
  {
    id: 'A-1004',
    name: 'Sam Rivera',
    role: 'Caregiver',
    stage: 'offer',
    appliedOn: '2026-08-30',
    notes: 'Offer extended; awaiting response.',
  },
  {
    id: 'A-1005',
    name: 'Sam Chen',
    role: 'Caregiver',
    stage: 'rejected',
    appliedOn: '2026-09-02',
    notes: 'Availability did not match the required shifts.',
  },
];
