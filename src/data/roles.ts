// What the Screener checks a resume against. Only job-related requirements: nothing here may
// depend on who a person is rather than whether they can do the job.

export type RoleRequirements = { mustHave: string[]; niceToHave: string[] };

export const ROLE_REQUIREMENTS: Record<string, RoleRequirements> = {
  'Executive Assistant': {
    mustHave: [
      '2 or more years supporting an executive or senior manager',
      'Managing complex calendars and scheduling meetings across time zones',
      'Coordinating business travel (flights, hotels, itineraries)',
      'Clear written communication, such as drafting emails and correspondence',
    ],
    niceToHave: [
      'Experience preparing board or leadership meeting materials',
      'Advanced skills with office or productivity software (for example Google Workspace or Microsoft 365)',
    ],
  },
  Recruiter: {
    mustHave: [
      '2 or more years of full-cycle recruiting (sourcing through offer)',
      'Sourcing candidates through job boards, referrals or professional networks',
      'Conducting screening interviews and coordinating interview loops',
      'Working with an applicant tracking system',
    ],
    niceToHave: [
      'Experience extending and negotiating offers',
      'Experience hiring for several different teams or job families',
    ],
  },
  Bookkeeper: {
    mustHave: [
      '2 or more years of bookkeeping or accounting work',
      'Accounts payable and accounts receivable',
      'Monthly bank and credit card reconciliations',
      'Using accounting software such as QuickBooks or Xero',
    ],
    niceToHave: [
      'Payroll processing',
      'A bookkeeping or accounting certification, with the issuing body and date',
      'Preparing month-end close or financial reports',
    ],
  },
  Caregiver: {
    mustHave: [
      '1 or more years of paid caregiving for older adults or people with disabilities',
      'A current CPR or first aid certification (a human must verify it is current)',
      'Help with daily living activities such as bathing, dressing, meals and mobility',
      'Keeping care notes, medication reminders or shift logs',
    ],
    niceToHave: [
      'Experience with dementia or memory care',
      'Home health aide or certified nursing assistant training',
    ],
  },
};

// Used for any role not listed above; the screening says so.
export const GENERAL_REQUIREMENTS: RoleRequirements = {
  mustHave: [
    'Work experience relevant to the role as titled',
    'Clear description of duties and results in past roles',
    'Consistent, plausible dates across the work history',
  ],
  niceToHave: ['Training, certifications or education relevant to the role'],
};

// Case-insensitive match on the role name. `general` is true when no role matched.
export function requirementsFor(role: string): { role: string; general: boolean; requirements: RoleRequirements } {
  const key = Object.keys(ROLE_REQUIREMENTS).find((r) => r.toLowerCase() === role.trim().toLowerCase());
  return key
    ? { role: key, general: false, requirements: ROLE_REQUIREMENTS[key]! }
    : { role: role.trim(), general: true, requirements: GENERAL_REQUIREMENTS };
}

// The open roles in a fixed order, with their criteria, for the state response and the
// get_role_requirements tool.
export const OPEN_ROLES = Object.entries(ROLE_REQUIREMENTS).map(([name, r]) => ({ name, ...r }));
