'use client';

import {
  Member,
  PaymentMethod,
  MemberStatus,
  MembershipPlan,
  Payment,
  Expense,
  UserProfile,
  DashboardKPIs,
  MonthlyTrendData,
  AuditLogEntry,
  AttendanceLog,
  Gym,
  GymDetails,
  GymRole,
  StaffMember,
} from '@/types/database';
import { INITIAL_PROFILE, getDemoGymData } from './mock-data';
import { createClient } from '@/lib/supabase/client';
import { getPaymentMemberName } from '@/lib/ui/format';
import { addMonthsToDateKey, getRecentMonthKeys, getTodayKey, toDateKey } from '@/lib/ui/date';

/** Only Cash and GCash are supported; anything else (legacy data) is treated as Cash. */
const normalizeMethod = (method: string | undefined): PaymentMethod =>
  method === 'GCash' ? 'GCash' : 'Cash';

const MAX_AUDIT_ENTRIES = 1000;
// Supabase returns at most 1000 rows per request, so bigger tables are read in pages.
const PAGE_SIZE = 1000;

// Columns the app may write for each table; derived fields like `plan` or `member` are never sent.
const PLAN_COLUMNS = ['name', 'price', 'duration_months', 'description', 'is_active'] as const;
const MEMBER_COLUMNS = [
  'first_name', 'last_name', 'email', 'phone', 'emergency_contact', 'membership_plan_id',
  'start_date', 'end_date', 'status', 'last_visit_date', 'notes',
] as const;
const PAYMENT_COLUMNS = [
  'member_id', 'member_name', 'membership_plan_id', 'amount', 'payment_date', 'payment_method',
  'payment_status', 'receipt_status', 'receipt_url', 'receipt_notes', 'verified_at', 'verified_by',
  'rejection_reason', 'reference_number', 'notes', 'is_walk_in',
] as const;
const EXPENSE_COLUMNS = ['category', 'title', 'amount', 'expense_date', 'payment_method', 'description'] as const;
const PROFILE_COLUMNS = ['full_name', 'phone'] as const;
const GYM_COLUMNS = ['name', 'address', 'phone', 'email', 'currency', 'opening_hours', 'walk_in_price', 'logo_url'] as const;
const LOGO_BUCKET = 'gym-logos';
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Everything the signed-in owner can see, loaded once per session and kept in step with each write. */
interface GymData {
  userId: string | null;
  /** The signed-in person, with gym_name and currency taken from their gym. */
  profile: UserProfile;
  gym: Gym | null;
  role: GymRole | null;
  staff: StaffMember[];
  plans: MembershipPlan[];
  members: Member[];
  payments: Payment[];
  expenses: Expense[];
  attendance: AttendanceLog[];
  audit: AuditLogEntry[];
}

const emptyData = (): GymData => ({
  userId: null,
  profile: INITIAL_PROFILE,
  gym: null,
  role: null,
  staff: [],
  plans: [],
  members: [],
  payments: [],
  expenses: [],
  attendance: [],
  audit: [],
});

let data: GymData = emptyData();
let loading: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
// Bumped by clear(), so a load that finishes after sign-out can't put the old account's data back.
let generation = 0;
const pendingAudit = new Set<PromiseLike<void>>();

const db = () => createClient();

// Keep only the given columns; empty strings become null so optional dates and plan ids are stored as empty.
function toRow(source: object, columns: readonly string[]): Record<string, unknown> {
  const values = source as Record<string, unknown>;
  const row: Record<string, unknown> = {};
  columns.forEach((col) => {
    if (!(col in values) || values[col] === undefined) return;
    row[col] = values[col] === '' ? null : values[col];
  });
  return row;
}

// Null text columns come back as '' so screens can keep treating them as strings.
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const optional = <T,>(v: T | null): T | undefined => (v === null ? undefined : v);

type Row = Record<string, unknown>;

const fromPlanRow = (r: Row): MembershipPlan => ({
  ...(r as unknown as MembershipPlan),
  price: Number(r.price),
  description: text(r.description),
});

const fromMemberRow = (r: Row): Member => ({
  ...(r as unknown as Member),
  email: text(r.email),
  phone: text(r.phone),
  emergency_contact: text(r.emergency_contact),
  membership_plan_id: text(r.membership_plan_id),
  end_date: text(r.end_date),
  last_visit_date: text(r.last_visit_date),
  notes: text(r.notes),
});

const fromPaymentRow = (r: Row): Payment => {
  const p: Row = {};
  Object.entries(r).forEach(([k, v]) => (p[k] = optional(v)));
  return {
    ...(p as unknown as Payment),
    member_id: text(r.member_id),
    amount: Number(r.amount),
    payment_method: normalizeMethod(r.payment_method as string),
  };
};

const fromExpenseRow = (r: Row): Expense => ({
  ...(r as unknown as Expense),
  amount: Number(r.amount),
  payment_method: normalizeMethod(r.payment_method as string),
  description: optional(r.description as string | null),
});

const fromProfileRow = (r: Row): UserProfile => ({
  ...(r as unknown as UserProfile),
  full_name: text(r.full_name),
  phone: text(r.phone),
});

const fromGymRow = (r: Row): Gym => ({
  ...(r as unknown as Gym),
  address: text(r.address),
  phone: text(r.phone),
  email: text(r.email),
  walk_in_price: r.walk_in_price === null || r.walk_in_price === undefined ? null : Number(r.walk_in_price),
  logo_url: (r.logo_url as string | null) || null,
});

// The file's path inside the logo bucket, taken from its public link.
const logoPath = (url: string | null): string | null => {
  const marker = `/${LOGO_BUCKET}/`;
  const at = url ? url.indexOf(marker) : -1;
  return url && at >= 0 ? decodeURIComponent(url.slice(at + marker.length)) : null;
};

const fromStaffRow = (r: Row): StaffMember => ({
  ...(r as unknown as StaffMember),
  full_name: text(r.full_name),
});

// Screens read the gym's name and currency from the profile, so keep them in step with the gym.
const withGym = (profile: UserProfile, gym: Gym | null): UserProfile =>
  gym ? { ...profile, gym_name: gym.name, currency: gym.currency } : profile;

const fromAuditRow = (r: Row): AuditLogEntry => ({
  ...(r as unknown as AuditLogEntry),
  entity_id: optional(r.entity_id as string | null),
  entity_label: optional(r.entity_label as string | null),
  metadata: optional(r.metadata as AuditLogEntry['metadata'] | null),
});

function check<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

// Row-level security makes a blocked delete remove nothing without an error. Treat that as a failure, so the
// item doesn't disappear here only to come back on the next refresh.
async function deleteById(table: string, id: string): Promise<void> {
  const rows = check(await db().from(table).delete().eq('id', id).select('id'));
  if (!rows || rows.length === 0) {
    throw new Error("It couldn't be deleted. It may already be gone (refresh the page), or you don't have permission.");
  }
}

async function fetchAll(table: string, orderBy: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = check(
      await db()
        .from(table)
        .select('*')
        .order(orderBy, { ascending: false })
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
    ) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Goes up on every change, so screens can tell when to recompute.
let revision = 1;

// A background refresh may already have picked up a row this device just saved; never list it twice.
const withoutId = <T extends { id: string }>(list: T[], id: string): T[] => list.filter((item) => item.id !== id);

function emit(name: string, detail?: unknown): void {
  revision += 1;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

// Derive the most recent N month buckets, ending with the current month.
function getRecentMonthBuckets(count: number): { month: string; monthKey: string }[] {
  return getRecentMonthKeys(count).map((monthKey) => {
    const [y, m] = monthKey.split('-').map(Number);
    return { month: new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' }), monthKey };
  });
}

// Format a Date as a local YYYY-MM-DD string (avoids UTC shifting a day).
function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Count paid members whose membership was active at any point within [start, end] (inclusive).
function countMembersActiveInWindow(members: Member[], start: string, end: string): number {
  return members.filter((m) => {
    if (m.status === 'pending' || !m.start_date || !m.end_date) return false;
    return m.start_date <= end && m.end_date >= start;
  }).length;
}

// Field names in `updates` whose value differs from `previous`; empty, null and undefined count as the same.
function changedFields(previous: object, updates: object): string[] {
  const before = previous as Record<string, unknown>;
  const norm = (v: unknown) => (v === undefined || v === null ? '' : v);
  return Object.entries(updates)
    .filter(([key, value]) => norm(before[key]) !== norm(value))
    .map(([key]) => key);
}

type AuditMetadata = NonNullable<AuditLogEntry['metadata']>;

const toAuditValue = (v: unknown): string | number | boolean | null =>
  v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);

// Audit metadata listing each changed field with its old and new value.
function diffMetadata(previous: object, updates: object): AuditMetadata {
  const before = previous as Record<string, unknown>;
  const after = updates as Record<string, unknown>;
  const fields = changedFields(previous, updates);
  const metadata: AuditMetadata = { changed: fields.join(', ') || 'none' };
  fields.forEach((field) => {
    metadata[`${field}.from`] = toAuditValue(before[field]);
    metadata[`${field}.to`] = toAuditValue(after[field]);
  });
  return metadata;
}

/** Thrown when a payment saved but a follow-up step failed; carries the saved payment. */
export class PaymentSavedError extends Error {
  constructor(public payment: Payment, message: string) {
    super(message);
    this.name = 'PaymentSavedError';
  }
}

// Written by triggers in 008_invite_accept_and_server_audit.sql.
const DATABASE_LOGGED_ACTIONS = new Set<AuditLogEntry['action']>([
  'payment.create',
  'payment.update',
  'payment.delete',
  'payment.receipt_verify',
  'payment.receipt_reject',
  'member.check_in_undo',
]);

export class DBService {
  // 0. Loading the signed-in owner's gym
  /** Loads this owner's data from Supabase (once per sign-in). Every getter reads from what this loaded. */
  static load(): Promise<void> {
    if (!loading) {
      loading = this.fetchGym().catch((err) => {
        loading = null;
        throw err;
      });
    }
    return loading;
  }

  static getRevision(): number {
    return revision;
  }

  static isLoaded(): boolean {
    return data.userId !== null;
  }

  /** Forget the previous owner's data, so the next account to sign in never sees it. */
  static clear(): void {
    data = emptyData();
    loading = null;
    generation += 1;
    emit('sgfm_profile_updated', data.profile);
  }

  /**
   * Reloads the gym's data in the background so changes made on another device (e.g. staff at the front desk) show up.
   * Screens reload their lists on the `sgfm_data_updated` event.
   */
  static refresh(): Promise<void> {
    if (!data.userId || loading === null || refreshing) return refreshing ?? Promise.resolve();
    refreshing = this.fetchGym({ background: true })
      .catch((err) => console.warn('Could not refresh gym data:', err instanceof Error ? err.message : err))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  private static async fetchGym({ background = false }: { background?: boolean } = {}): Promise<void> {
    const startedIn = generation;
    const revisionAtStart = revision;
    // The local session saves a round trip to the Auth server; every query below is still checked by RLS.
    let user = null;
    try {
      const { data: auth } = await db().auth.getSession();
      user = auth.session?.user ?? null;
    } catch {
      user = null;
    }
    if (!user) {
      data = getDemoGymData();
      emit('sgfm_profile_updated', data.profile);
      emit('sgfm_data_updated');
      return;
    }

    const [profileRow, myStaffRow] = await Promise.all([
      db().from('profiles').select('*').eq('id', user.id).maybeSingle().then(check),
      db().from('gym_staff').select('*').eq('user_id', user.id).eq('status', 'active').maybeSingle().then(check),
    ]);

    // An account made before the signup trigger existed may not have a profile row yet.
    let profile = profileRow as Row | null;
    if (!profile) {
      const meta = user.user_metadata || {};
      profile = check(
        await db()
          .from('profiles')
          .insert({
            id: user.id,
            email: user.email || '',
            full_name: meta.full_name || meta.name || 'Gym Administrator',
            gym_name: meta.gym_name || 'My Fitness Gym',
          })
          .select()
          .single()
      ) as Row;
    }

    const staffRow = myStaffRow as Row | null;
    const role = (staffRow?.role as GymRole | undefined) ?? null;
    const isOwner = role === 'owner';
    const none = Promise.resolve([] as Row[]);

    // No gym yet: the person goes to onboarding, so there is nothing else to load.
    const [gymRow, team, plans, members, payments, expenses, attendance, audit] = staffRow
      ? await Promise.all([
          db().from('gyms').select('*').eq('id', staffRow.gym_id as string).single().then(check),
          isOwner ? fetchAll('gym_staff', 'created_at') : none,
          fetchAll('membership_plans', 'created_at'),
          fetchAll('members', 'created_at'),
          fetchAll('payments', 'created_at'),
          // Only the owner can see expenses and the audit log.
          isOwner ? fetchAll('expenses', 'expense_date') : none,
          fetchAll('attendance_logs', 'check_in_time'),
          isOwner
            ? db()
                .from('audit_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(MAX_AUDIT_ENTRIES)
                .then(check)
            : none,
        ])
      : [null, [], [], [], [], [], [], []];

    // Signed out or switched accounts meanwhile: load again for whoever is signed in now.
    if (startedIn !== generation) return background ? undefined : this.load();
    // Something was saved on this device while loading; this copy may be missing it, so wait for the next refresh.
    if (background && revision !== revisionAtStart) return;
    const gym = gymRow ? fromGymRow(gymRow as Row) : null;
    // Remember which gym this person works at as staff. If the owner removes them they land on onboarding,
    // and this lets it say why, even after a reload or on their next sign-in on this device.
    try {
      const staffGymKey = `sgfm_staff_gym:${user.id}`;
      if (role === 'staff' && gym) {
        localStorage.setItem(staffGymKey, gym.name);
      } else if (role) {
        localStorage.removeItem(staffGymKey);
      } else {
        const removedFrom = localStorage.getItem(staffGymKey);
        if (removedFrom) {
          sessionStorage.setItem('sgfm_removed_from', removedFrom);
          localStorage.removeItem(staffGymKey);
        }
      }
    } catch {
      // Storage blocked: only the explanation is lost.
    }
    data = {
      userId: user.id,
      profile: withGym(fromProfileRow(profile), gym),
      gym,
      role,
      staff: (team as Row[]).map(fromStaffRow).reverse(),
      plans: (plans as Row[]).map(fromPlanRow).reverse(),
      members: (members as Row[]).map(fromMemberRow),
      payments: (payments as Row[]).map(fromPaymentRow),
      expenses: (expenses as Row[]).map(fromExpenseRow),
      attendance: attendance as unknown as AttendanceLog[],
      audit: ((audit as Row[]) || []).map(fromAuditRow),
    };
    emit('sgfm_profile_updated', data.profile);
    emit('sgfm_data_updated');
  }

  // 1. Profile / Settings
  static getProfile(): UserProfile {
    return data.profile;
  }

  static getFirstName(fullName?: string): string {
    // "Gym Administrator" is the placeholder for accounts made without a name; "Gym" isn't a first name.
    if (!fullName || !fullName.trim() || fullName.trim() === 'Gym Administrator') return 'Admin';
    const first = fullName.trim().split(/\s+/)[0];
    return first || 'Admin';
  }

  /** The signed-in person's name, or their email when the account has no real name ("Gym Administrator" is the placeholder). */
  static displayName(profile?: Pick<UserProfile, 'full_name' | 'email'> | null): string {
    const name = profile?.full_name?.trim();
    return name && name !== 'Gym Administrator' ? name : profile?.email || 'Admin';
  }

  static getInitials(fullName?: string): string {
    if (!fullName || !fullName.trim()) return 'AD';
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'AD';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** Saves the signed-in person's own name and phone. Gym details go through updateGym. */
  static async updateProfile(updates: Partial<Pick<UserProfile, 'full_name' | 'phone'>>): Promise<UserProfile> {
    const current = this.getProfile();
    const row = check(
      await db().from('profiles').update(toRow(updates, PROFILE_COLUMNS)).eq('id', current.id).select().single()
    ) as Row;
    const updated = withGym(fromProfileRow(row), data.gym);
    data.profile = updated;
    // The database copies the new name onto the staff list (009_sync_staff_names.sql); mirror it here.
    data.staff = data.staff.map((s) => (s.user_id === updated.id ? { ...s, full_name: updated.full_name } : s));
    emit('sgfm_profile_updated', updated);
    if (changedFields(current, updates).length > 0) {
      this.recordAudit({
        action: 'settings.update',
        entity_type: 'settings',
        entity_id: updated.id,
        entity_label: updated.full_name || updated.email || 'Profile',
        metadata: diffMetadata(current, updates),
      });
    }
    return updated;
  }

  // 1a. Gym and staff
  static getGym(): Gym | null {
    return data.gym;
  }

  static getRole(): GymRole | null {
    return data.role;
  }

  static isOwner(): boolean {
    return data.role === 'owner';
  }

  /** True until the owner has filled in their gym's details (also when the person has no gym at all). */
  static needsOnboarding(): boolean {
    return !data.gym || (data.role === 'owner' && !data.gym.onboarded_at);
  }

  /** Onboarding: creates the gym with the signed-in person as owner, then loads it. */
  /** An invite waiting for this account's email, shown on onboarding so they can choose to join. */
  static async getPendingInvite(): Promise<{ invite_id: string; gym_name: string } | null> {
    const rows = check(await db().rpc('pending_invite')) as { invite_id: string; gym_name: string }[] | null;
    return rows?.[0] ?? null;
  }

  static async acceptInvite(inviteId: string): Promise<void> {
    check(await db().rpc('accept_invite', { p_invite: inviteId }));
    loading = null;
    await this.load();
  }

  static async declineInvite(inviteId: string): Promise<void> {
    check(await db().rpc('decline_invite', { p_invite: inviteId }));
  }

  static async createGym(details: GymDetails): Promise<Gym> {
    check(
      await db().rpc('create_gym', {
        p_name: details.name,
        p_address: details.address,
        p_phone: details.phone,
        p_email: details.email,
        p_currency: details.currency,
        p_opening_hours: details.opening_hours,
        p_walk_in_price: details.walk_in_price,
      })
    );
    loading = null;
    await this.load();
    const gym = data.gym;
    if (!gym) throw new Error('The gym was created but could not be loaded. Please refresh.');
    this.recordAudit({
      action: 'gym.onboard',
      entity_type: 'settings',
      entity_id: gym.id,
      entity_label: gym.name,
      metadata: { address: gym.address || null },
    });
    return gym;
  }

  static async updateGym(updates: Partial<GymDetails> & Partial<Pick<Gym, 'logo_url'>>): Promise<Gym> {
    const current = data.gym;
    if (!current) throw new Error('No gym to update');
    const row = check(
      await db().from('gyms').update(toRow(updates, GYM_COLUMNS)).eq('id', current.id).select().single()
    ) as Row;
    const gym = fromGymRow(row);
    data.gym = gym;
    data.profile = withGym(data.profile, gym);
    emit('sgfm_profile_updated', data.profile);

    // Opening hours are an object; compare them as text so an unchanged schedule isn't logged.
    const flat = (g: Partial<GymDetails>) =>
      'opening_hours' in g ? { ...g, opening_hours: g.opening_hours ? JSON.stringify(g.opening_hours) : null } : g;
    if (changedFields(flat(current), flat(updates)).length > 0) {
      this.recordAudit({
        action: 'settings.update',
        entity_type: 'settings',
        entity_id: gym.id,
        entity_label: gym.name,
        metadata: diffMetadata(flat(current), flat(updates)),
      });
    }
    return gym;
  }

  /** Why a file can't be used as a logo, or null if it can. */
  static logoFileProblem(file: File): string | null {
    if (!LOGO_TYPES[file.type]) return 'Please choose a PNG, JPG or WebP image.';
    if (file.size > MAX_LOGO_BYTES) return 'The logo must be 2 MB or smaller.';
    return null;
  }

  /** Uploads a new gym logo (PNG, JPEG or WebP, up to 2 MB) and removes the previous one. Owner only. */
  static async uploadGymLogo(file: File): Promise<Gym> {
    const gym = data.gym;
    if (!gym) throw new Error('No gym to add a logo to');
    const problem = this.logoFileProblem(file);
    if (problem) throw new Error(problem);
    const ext = LOGO_TYPES[file.type];

    // A new name every time, so browsers never keep showing the old logo from their cache.
    const path = `${gym.id}/logo-${Date.now()}.${ext}`;
    check(await db().storage.from(LOGO_BUCKET).upload(path, file, { contentType: file.type }));
    const { data: link } = db().storage.from(LOGO_BUCKET).getPublicUrl(path);

    const oldPath = logoPath(gym.logo_url);
    const updated = await this.updateGym({ logo_url: link.publicUrl });
    if (oldPath) await db().storage.from(LOGO_BUCKET).remove([oldPath]);
    return updated;
  }

  /** Goes back to the app logo and deletes the uploaded file. Owner only. */
  static async removeGymLogo(): Promise<Gym> {
    const oldPath = logoPath(data.gym?.logo_url ?? null);
    const updated = await this.updateGym({ logo_url: null });
    if (oldPath) await db().storage.from(LOGO_BUCKET).remove([oldPath]);
    return updated;
  }

  static getStaff(): StaffMember[] {
    return data.staff;
  }

  /** A team member's name, or their email when the account has no real name ("Gym Administrator" is the placeholder). */
  static staffName(member: StaffMember): string {
    const name = member.full_name?.trim();
    return name && name !== 'Gym Administrator' ? name : member.email;
  }

  /** The person joins this gym the first time they sign up or sign in with this email. */
  static async inviteStaff(email: string): Promise<StaffMember> {
    const address = email.trim().toLowerCase();
    if (!address) throw new Error('Enter an email address');
    if (data.staff.some((s) => s.email.toLowerCase() === address)) {
      throw new Error('That email is already on your staff list');
    }
    if (!data.gym) throw new Error('Finish setting up your gym first');
    // gym_staff has no gym_id default (unlike the data tables), so it has to be sent.
    const row = check(
      await db()
        .from('gym_staff')
        .insert({ gym_id: data.gym.id, email: address, role: 'staff', status: 'invited' })
        .select()
        .single()
    ) as Row;
    const invite = fromStaffRow(row);
    data.staff = [...withoutId(data.staff, invite.id), invite];

    this.recordAudit({
      action: 'staff.invite',
      entity_type: 'staff',
      entity_id: invite.id,
      entity_label: address,
    });
    return invite;
  }

  /** Removes a staff member or cancels an invite; they lose access straight away. */
  static async removeStaff(id: string): Promise<void> {
    const member = data.staff.find((s) => s.id === id);
    if (!member) throw new Error('Staff member not found');
    if (member.role === 'owner') throw new Error('The owner cannot be removed');
    await deleteById('gym_staff', id);
    data.staff = data.staff.filter((s) => s.id !== id);

    this.recordAudit({
      action: 'staff.remove',
      entity_type: 'staff',
      entity_id: id,
      entity_label: this.staffName(member),
      metadata: { email: member.email, status: member.status },
    });
  }

  // 1b. User Audit Trail
  static getAuditLog(): AuditLogEntry[] {
    return data.audit;
  }

  /** Shows up in the log right away and is saved in the background, so it never holds up the action it records. */
  static recordAudit(
    input: Omit<AuditLogEntry, 'id' | 'admin_id' | 'actor_email' | 'created_at'>
  ): AuditLogEntry {
    const profile = this.getProfile();
    const entry: AuditLogEntry = {
      ...input,
      id: crypto.randomUUID(),
      admin_id: data.userId || profile.id,
      actor_email: profile.email,
      created_at: new Date().toISOString(),
    };
    // The log belongs to a gym; before onboarding (or after being removed as staff) there is none to write to.
    if (!data.gym) return entry;
    data.audit = [entry, ...withoutId(data.audit, entry.id)].slice(0, MAX_AUDIT_ENTRIES);
    emit('sgfm_audit_updated', entry);

    // The database logs these itself (so API calls are recorded too); saving them here would double them.
    if (DATABASE_LOGGED_ACTIONS.has(entry.action)) return entry;

    const { admin_id, ...row } = entry;
    void admin_id; // filled in by the database from the signed-in account
    const saving = db()
      .from('audit_logs')
      .insert(row)
      .then(({ error }) => {
        if (error) console.warn('Could not save audit entry:', error.message);
      });
    pendingAudit.add(saving);
    saving.then(() => pendingAudit.delete(saving));
    return entry;
  }

  /** Waits for audit entries still being saved (call before signing out, while writes are still allowed). */
  static async flushAudit(): Promise<void> {
    await Promise.all(pendingAudit);
  }

  private static memberLabel(member?: Member): string {
    if (!member) return 'Unknown member';
    return `${member.first_name} ${member.last_name}`.trim() || member.id;
  }

  // 2. Membership Plans
  static getPlans(): MembershipPlan[] {
    return data.plans;
  }

  static async addPlan(plan: Omit<MembershipPlan, 'id' | 'admin_id' | 'created_at'>): Promise<MembershipPlan> {
    const row = check(
      await db().from('membership_plans').insert(toRow(plan, PLAN_COLUMNS)).select().single()
    ) as Row;
    const newPlan = fromPlanRow(row);
    data.plans = [...withoutId(data.plans, newPlan.id), newPlan];

    const currency = this.getProfile().currency || '₱';
    this.recordAudit({
      action: 'plan.create',
      entity_type: 'plan',
      entity_id: newPlan.id,
      entity_label: `${newPlan.name} · ${currency}${Number(newPlan.price).toLocaleString()}`,
      metadata: {
        price: Number(newPlan.price),
        duration_months: newPlan.duration_months,
      },
    });

    return newPlan;
  }

  static async updatePlan(
    id: string,
    updates: Partial<Omit<MembershipPlan, 'id' | 'admin_id' | 'created_at'>>
  ): Promise<MembershipPlan> {
    const previous = data.plans.find((p) => p.id === id);
    if (!previous) throw new Error('Plan not found');

    const row = check(
      await db().from('membership_plans').update(toRow(updates, PLAN_COLUMNS)).eq('id', id).select().single()
    ) as Row;
    const updatedPlan = fromPlanRow(row);
    data.plans = data.plans.map((p) => (p.id === id ? updatedPlan : p));

    const changed = changedFields(previous, updates);
    if (changed.length === 1 && changed[0] === 'is_active') {
      this.recordAudit({
        action: updatedPlan.is_active ? 'plan.activate' : 'plan.deactivate',
        entity_type: 'plan',
        entity_id: id,
        entity_label: updatedPlan.name || id,
      });
      return updatedPlan;
    }
    const currency = this.getProfile().currency || '₱';
    this.recordAudit({
      action: 'plan.update',
      entity_type: 'plan',
      entity_id: id,
      entity_label: `${updatedPlan.name || id} · ${currency}${Number(updatedPlan.price).toLocaleString()}`,
      metadata: diffMetadata(previous, updates),
    });

    return updatedPlan;
  }

  // 3. Members
  static getMembers(): Member[] {
    const planMap = new Map(data.plans.map((p) => [p.id, p]));

    // Check expiration and payment presence dynamically
    // Local date (not UTC), parsed the same way as end_date so the day difference is exact.
    const todayStr = formatDateLocal(new Date());
    const today = new Date(todayStr);

    // Only completed payments count; a pending, rejected, or refunded payment doesn't make a member active.
    const memberIdsWithPayments = new Set(
      data.payments.filter((p) => p.payment_status === 'completed').map((p) => p.member_id)
    );

    return data.members.map((m) => {
      let status: MemberStatus = m.status;

      // Members with no completed payment yet stay pending until one is recorded.
      if (!memberIdsWithPayments.has(m.id)) {
        status = 'pending';
      } else if (m.end_date) {
        const endDate = new Date(m.end_date);
        const diffDays = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < 0) {
          status = 'expired';
        } else if (diffDays <= 7) {
          status = 'expiring';
        } else {
          status = 'active';
        }
      }
      return {
        ...m,
        status,
        plan: planMap.get(m.membership_plan_id),
      };
    });
  }

  static getMemberById(id: string): Member | undefined {
    return this.getMembers().find((m) => m.id === id);
  }

  static async addMember(
    input: Omit<Member, 'id' | 'admin_id' | 'created_at' | 'updated_at' | 'status'>
  ): Promise<Member> {
    // Newly registered member starts as pending until recorded on payments page
    const row = check(
      await db()
        .from('members')
        .insert(toRow({ ...input, status: 'pending' }, MEMBER_COLUMNS))
        .select()
        .single()
    ) as Row;
    const newMember = fromMemberRow(row);
    data.members = [newMember, ...withoutId(data.members, newMember.id)];

    this.recordAudit({
      action: 'member.create',
      entity_type: 'member',
      entity_id: newMember.id,
      entity_label: this.memberLabel(newMember),
      metadata: {
        plan_id: newMember.membership_plan_id,
        start_date: newMember.start_date,
        end_date: newMember.end_date,
      },
    });

    return newMember;
  }

  /** Saves member fields without an audit entry (used for check-ins, which would flood the log). */
  private static async saveMember(id: string, updates: Partial<Member>): Promise<Member> {
    const row = check(
      await db().from('members').update(toRow(updates, MEMBER_COLUMNS)).eq('id', id).select().single()
    ) as Row;
    const saved = fromMemberRow(row);
    data.members = data.members.map((m) => (m.id === id ? saved : m));
    return saved;
  }

  static async updateMember(id: string, updates: Partial<Member>): Promise<Member> {
    const previous = data.members.find((m) => m.id === id);
    if (!previous) throw new Error('Member not found');

    const updatedMember = await this.saveMember(id, updates);

    this.recordAudit({
      action: 'member.update',
      entity_type: 'member',
      entity_id: id,
      entity_label: this.memberLabel(updatedMember),
      metadata: diffMetadata(previous, updates),
    });

    return updatedMember;
  }

  static async deleteMember(id: string): Promise<void> {
    const member = data.members.find((m) => m.id === id);

    // Keep this member's payments so past revenue stays correct; save their name on each one.
    // The database then unlinks them from the member and removes the member's check-ins.
    const memberName = this.memberLabel(member);
    check(await db().from('payments').update({ member_name: memberName }).eq('member_id', id));
    await deleteById('members', id);

    let paymentsKept = 0;
    data.payments = data.payments.map((p) => {
      if (p.member_id !== id) return p;
      paymentsKept += 1;
      return { ...p, member_id: '', member_name: memberName };
    });
    data.members = data.members.filter((m) => m.id !== id);
    data.attendance = data.attendance.filter((a) => a.member_id !== id);

    this.recordAudit({
      action: 'member.delete',
      entity_type: 'member',
      entity_id: id,
      entity_label: memberName,
      metadata: {
        email: member?.email || null,
        phone: member?.phone || null,
        plan_id: member?.membership_plan_id || null,
        start_date: member?.start_date || null,
        end_date: member?.end_date || null,
        payments_kept: paymentsKept,
      },
    });
  }

  // 3b. Attendance (check-ins)
  // Check-ins aren't written to the Audit Log: a busy gym would push everything else out of it within days.
  static getAttendance(memberId?: string): AttendanceLog[] {
    return data.attendance
      .filter((a) => !memberId || a.member_id === memberId)
      .sort((a, b) => b.check_in_time.localeCompare(a.check_in_time));
  }

  static isCheckedInToday(memberId: string): boolean {
    const today = getTodayKey();
    return this.getAttendance(memberId).some((a) => toDateKey(new Date(a.check_in_time)) === today);
  }

  static async checkInMember(memberId: string): Promise<AttendanceLog> {
    if (!data.members.some((m) => m.id === memberId)) throw new Error('Member not found');
    if (this.isCheckedInToday(memberId)) throw new Error('Already checked in today');

    const result = await db()
      .from('attendance_logs')
      .insert({ member_id: memberId, check_in_time: new Date().toISOString() })
      .select()
      .single();
    // The database allows one check-in per member per day; another device may have just checked them in.
    if (result.error?.code === '23505') {
      void this.refresh();
      throw new Error('Already checked in today');
    }
    const log = check(result) as unknown as AttendanceLog;
    data.attendance = [log, ...withoutId(data.attendance, log.id)];

    // The visit is saved by now; if updating "last visit" fails, don't report the check-in as failed
    // (a retry would only say "already checked in"). The visit itself still shows in Attendance.
    try {
      await this.saveMember(memberId, { last_visit_date: getTodayKey() });
    } catch (err) {
      console.warn('Check-in saved, but last visit date did not update:', err);
    }

    this.notifyAttendanceChanged();
    return log;
  }

  static async undoCheckIn(logId: string): Promise<void> {
    const log = data.attendance.find((a) => a.id === logId);
    if (!log) throw new Error('Check-in not found');
    await deleteById('attendance_logs', logId);
    data.attendance = data.attendance.filter((a) => a.id !== logId);

    // Last visit goes back to the newest remaining check-in, or the start date if there are none.
    const member = data.members.find((m) => m.id === log.member_id);
    if (member) {
      const previousVisit = data.attendance
        .filter((a) => a.member_id === log.member_id)
        .map((a) => a.check_in_time)
        .sort()
        .pop();
      await this.saveMember(member.id, {
        last_visit_date: previousVisit ? toDateKey(new Date(previousVisit)) : member.start_date,
      });
    }

    this.recordAudit({
      action: 'member.check_in_undo',
      entity_type: 'member',
      entity_id: log.member_id,
      entity_label: this.memberLabel(member),
      metadata: { check_in_time: log.check_in_time },
    });
    this.notifyAttendanceChanged();
  }

  private static notifyAttendanceChanged(): void {
    emit('sgfm_attendance_updated');
  }

  // 4. Payments
  static getPayments(): Payment[] {
    const memberMap = new Map(this.getMembers().map((m) => [m.id, m]));
    const planMap = new Map(data.plans.map((p) => [p.id, p]));

    return data.payments.map((p) => ({
      ...p,
      member: memberMap.get(p.member_id),
      plan: p.membership_plan_id ? planMap.get(p.membership_plan_id) : undefined,
    }));
  }

  private static async savePayment(id: string, updates: Partial<Payment>): Promise<Payment> {
    const row = check(
      await db().from('payments').update(toRow(updates, PAYMENT_COLUMNS)).eq('id', id).select().single()
    ) as Row;
    const saved = fromPaymentRow(row);
    data.payments = data.payments.map((p) => (p.id === id ? saved : p));
    return saved;
  }

  /**
   * A completed membership payment activates a new member, or extends a renewing or expired one by the plan's months.
   * Runs only when a payment becomes completed, so an unverified GCash payment changes nothing until it's verified.
   */
  private static async applyPaymentToMembership(payment: Payment): Promise<void> {
    if (payment.payment_status !== 'completed' || payment.is_walk_in || !payment.membership_plan_id) return;
    const member = data.members.find((m) => m.id === payment.member_id);
    const plan = data.plans.find((p) => p.id === payment.membership_plan_id);
    if (!member || !plan) return;

    const today = getTodayKey();
    const isRenewal = data.payments.some(
      (p) => p.member_id === member.id && p.payment_status === 'completed' && p.id !== payment.id
    );
    const isExpired = Boolean(member.end_date) && member.end_date < today;

    if (isRenewal || isExpired) {
      const baseDate = member.end_date > today ? member.end_date : today;
      await this.updateMember(member.id, {
        end_date: addMonthsToDateKey(baseDate, plan.duration_months),
        status: 'active',
        membership_plan_id: plan.id,
      });
    } else if (member.membership_plan_id !== plan.id || !member.start_date) {
      // First payment, but for a different plan than they registered with: their period follows the paid plan.
      const startDate = member.start_date || today;
      await this.updateMember(member.id, {
        start_date: startDate,
        end_date: addMonthsToDateKey(startDate, plan.duration_months),
        status: 'active',
        membership_plan_id: plan.id,
      });
    } else {
      // First payment for a newly registered member: their dates were set when they registered.
      await this.updateMember(member.id, { status: 'active' });
    }
  }

  /** Walk-in payments (one-time visitors), newest first. Pass a date (YYYY-MM-DD) to get just that day's. */
  static getWalkIns(date?: string): Payment[] {
    return this.getPayments().filter((p) => p.is_walk_in && (!date || p.payment_date === date));
  }

  /** Records a one-time visitor who pays at the door, without registering them as a member. */
  static addWalkIn(input: {
    name?: string;
    amount: number;
    payment_method: PaymentMethod;
    reference_number?: string;
    notes?: string;
  }): Promise<Payment> {
    return this.addPayment({
      member_id: '',
      member_name: input.name?.trim() || undefined,
      is_walk_in: true,
      amount: input.amount,
      payment_date: getTodayKey(),
      payment_method: input.payment_method,
      // GCash only counts once someone checks the receipt.
      payment_status: input.payment_method === 'GCash' ? 'pending' : 'completed',
      reference_number: input.reference_number,
      notes: input.notes,
    });
  }

  static async addPayment(input: Omit<Payment, 'id' | 'admin_id' | 'created_at'>): Promise<Payment> {
    const payer = input.member_id && !input.is_walk_in ? this.getMemberById(input.member_id) : undefined;
    const row = check(
      await db()
        .from('payments')
        .insert(
          toRow(
            {
              ...input,
              // Saved now so deleting the member later doesn't have to fill it in on every payment,
              // which the audit log would record as an edit to each one.
              member_name: input.member_name || (payer ? this.memberLabel(payer) : undefined),
              receipt_status: input.receipt_status || (input.payment_method === 'Cash' ? 'verified' : 'unverified'),
            },
            PAYMENT_COLUMNS
          )
        )
        .select()
        .single()
    ) as Row;
    const newPayment = fromPaymentRow(row);
    data.payments = [newPayment, ...withoutId(data.payments, newPayment.id)];

    const member = this.getMemberById(newPayment.member_id);
    const currency = this.getProfile().currency || '₱';
    this.recordAudit({
      action: 'payment.create',
      entity_type: 'payment',
      entity_id: newPayment.id,
      entity_label: `${newPayment.is_walk_in ? getPaymentMemberName(newPayment) : this.memberLabel(member)} · ${currency}${Number(newPayment.amount).toLocaleString()}`,
      metadata: {
        amount: Number(newPayment.amount),
        method: newPayment.payment_method,
        status: newPayment.payment_status,
        receipt_status: newPayment.receipt_status || 'unverified',
        member_id: newPayment.member_id,
      },
    });

    await this.applySavedPayment(newPayment);
    return newPayment;
  }

  // The payment is already saved by now, so a failure here must not read as "the payment failed",
  // or the user records it again and it is counted twice.
  private static async applySavedPayment(payment: Payment): Promise<void> {
    try {
      await this.applyPaymentToMembership(payment);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      throw new PaymentSavedError(
        payment,
        `The payment was saved, but the membership dates didn't update (${reason}). Don't record it again; edit the member to fix the dates.`
      );
    }
  }

  static async updatePayment(id: string, updates: Partial<Payment>): Promise<Payment> {
    const previous = data.payments.find((p) => p.id === id);
    if (!previous) throw new Error('Payment not found');

    const updatedPayment = await this.savePayment(id, updates);

    this.recordAudit({
      action: 'payment.update',
      entity_type: 'payment',
      entity_id: id,
      entity_label: `Payment #${updatedPayment.reference_number || id}`,
      metadata: {
        ...diffMetadata(previous, updates),
        payment_status: updatedPayment.payment_status,
        amount: Number(updatedPayment.amount),
        receipt_status: updatedPayment.receipt_status || 'unverified',
      },
    });

    // Only a pending payment hasn't been applied yet; a refunded one may have been completed before.
    if (previous.payment_status === 'pending') await this.applySavedPayment(updatedPayment);
    return updatedPayment;
  }

  static async verifyPaymentReceipt(id: string, options?: { notes?: string }): Promise<Payment> {
    const profile = this.getProfile();
    const current = data.payments.find((p) => p.id === id);
    if (!current) throw new Error('Payment not found');

    const updatedPayment = await this.savePayment(id, {
      payment_status: 'completed',
      receipt_status: 'verified',
      verified_at: new Date().toISOString(),
      verified_by: profile.full_name || profile.email || 'Admin',
      receipt_notes: options?.notes || current.receipt_notes,
    });

    const member = this.getMemberById(updatedPayment.member_id);
    const currency = profile.currency || '₱';

    this.recordAudit({
      action: 'payment.receipt_verify',
      entity_type: 'payment',
      entity_id: id,
      entity_label: `${getPaymentMemberName({ ...updatedPayment, member })} · ${currency}${Number(updatedPayment.amount).toLocaleString()}`,
      metadata: {
        receipt_status: 'verified',
        reference_number: updatedPayment.reference_number || '',
        verified_by: updatedPayment.verified_by || 'Admin',
        notes: options?.notes || '',
      },
    });

    if (current.payment_status === 'pending') await this.applySavedPayment(updatedPayment);
    return updatedPayment;
  }

  static async rejectPaymentReceipt(id: string, reason: string): Promise<Payment> {
    const profile = this.getProfile();
    const current = data.payments.find((p) => p.id === id);
    if (!current) throw new Error('Payment not found');
    if (current.payment_status === 'completed') {
      throw new Error('This payment is already counted and extended the membership. Delete it instead if it was a mistake.');
    }

    const updatedPayment = await this.savePayment(id, {
      payment_status: 'pending',
      receipt_status: 'rejected',
      verified_at: new Date().toISOString(),
      verified_by: profile.full_name || profile.email || 'Admin',
      rejection_reason: reason,
    });

    const member = this.getMemberById(updatedPayment.member_id);
    const currency = profile.currency || '₱';

    this.recordAudit({
      action: 'payment.receipt_reject',
      entity_type: 'payment',
      entity_id: id,
      entity_label: `${getPaymentMemberName({ ...updatedPayment, member })} · ${currency}${Number(updatedPayment.amount).toLocaleString()}`,
      metadata: {
        receipt_status: 'rejected',
        payment_status: 'pending',
        reference_number: current.reference_number || '',
        rejection_reason: reason,
        verified_by: updatedPayment.verified_by || 'Admin',
      },
    });

    return updatedPayment;
  }

  static async deletePayment(id: string): Promise<void> {
    const payment = data.payments.find((p) => p.id === id);
    await deleteById('payments', id);
    data.payments = data.payments.filter((p) => p.id !== id);

    this.recordAudit({
      action: 'payment.delete',
      entity_type: 'payment',
      entity_id: id,
      entity_label: `Payment #${payment?.reference_number || id}`,
      metadata: {
        amount: Number(payment?.amount || 0),
        payment_date: payment?.payment_date || null,
        method: payment?.payment_method || null,
        status: payment?.payment_status || null,
        member_id: payment?.member_id || null,
      },
    });
  }

  // 5. Expenses
  static getExpenses(): Expense[] {
    return data.expenses;
  }

  static async addExpense(
    input: Omit<Expense, 'id' | 'admin_id' | 'created_at' | 'updated_at'>
  ): Promise<Expense> {
    const row = check(
      await db().from('expenses').insert(toRow(input, EXPENSE_COLUMNS)).select().single()
    ) as Row;
    const newExpense = fromExpenseRow(row);
    data.expenses = [newExpense, ...withoutId(data.expenses, newExpense.id)];

    const currency = this.getProfile().currency || '₱';
    this.recordAudit({
      action: 'expense.create',
      entity_type: 'expense',
      entity_id: newExpense.id,
      entity_label: `${newExpense.title} · ${currency}${Number(newExpense.amount).toLocaleString()}`,
      metadata: {
        category: newExpense.category,
        amount: Number(newExpense.amount),
      },
    });

    return newExpense;
  }

  static async updateExpense(id: string, updates: Partial<Expense>): Promise<Expense> {
    const previous = data.expenses.find((e) => e.id === id);
    if (!previous) throw new Error('Expense not found');

    const row = check(
      await db().from('expenses').update(toRow(updates, EXPENSE_COLUMNS)).eq('id', id).select().single()
    ) as Row;
    const updatedExpense = fromExpenseRow(row);
    data.expenses = data.expenses.map((e) => (e.id === id ? updatedExpense : e));

    this.recordAudit({
      action: 'expense.update',
      entity_type: 'expense',
      entity_id: id,
      entity_label: updatedExpense.title || id,
      metadata: diffMetadata(previous, updates),
    });

    return updatedExpense;
  }

  static async deleteExpense(id: string): Promise<void> {
    const expense = data.expenses.find((e) => e.id === id);
    await deleteById('expenses', id);
    data.expenses = data.expenses.filter((e) => e.id !== id);

    this.recordAudit({
      action: 'expense.delete',
      entity_type: 'expense',
      entity_id: id,
      entity_label: expense?.title || id,
      metadata: {
        amount: Number(expense?.amount || 0),
        category: expense?.category || null,
        expense_date: expense?.expense_date || null,
        method: expense?.payment_method || null,
      },
    });
  }

  // 7. Dashboard Financial KPI Calculation
  static getDashboardKPIs(
    timeframe: 'this-month' | 'last-month' | 'last-month-to-date' | 'last-3-months' | 'last-6-months' | 'this-year' = 'this-month'
  ): DashboardKPIs {
    const members = this.getMembers();
    const payments = this.getPayments();
    const expenses = this.getExpenses();

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0 to 11

    const thisMonthKey = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    let filteredPayments = payments.filter((p) => p.payment_status === 'completed');
    let filteredExpenses = expenses;
    let label = 'This Month';

    if (timeframe === 'last-month') {
      label = 'Last Month';
      filteredPayments = filteredPayments.filter((p) => (p.payment_date || '').startsWith(lastMonthKey));
      filteredExpenses = filteredExpenses.filter((e) => (e.expense_date || '').startsWith(lastMonthKey));
    } else if (timeframe === 'last-month-to-date') {
      // Last month up to today's day number, so a month in progress is compared fairly.
      label = 'Last Month to Date';
      const lastDay = `${lastMonthKey}-${String(now.getDate()).padStart(2, '0')}`;
      const inRange = (date: string | undefined) => (date || '').startsWith(lastMonthKey) && (date || '') <= lastDay;
      filteredPayments = filteredPayments.filter((p) => inRange(p.payment_date));
      filteredExpenses = filteredExpenses.filter((e) => inRange(e.expense_date));
    } else if (timeframe === 'this-month') {
      label = 'This Month';
      filteredPayments = filteredPayments.filter((p) => (p.payment_date || '').startsWith(thisMonthKey));
      filteredExpenses = filteredExpenses.filter((e) => (e.expense_date || '').startsWith(thisMonthKey));
    } else if (timeframe === 'last-3-months' || timeframe === 'last-6-months') {
      const count = timeframe === 'last-3-months' ? 3 : 6;
      label = timeframe === 'last-3-months' ? 'Last 3 Months' : 'Last 6 Months';
      const monthKeys = getRecentMonthBuckets(count).map((b) => b.monthKey);
      filteredPayments = filteredPayments.filter((p) =>
        monthKeys.some((k) => (p.payment_date || '').startsWith(k))
      );
      filteredExpenses = filteredExpenses.filter((e) =>
        monthKeys.some((k) => (e.expense_date || '').startsWith(k))
      );
    } else if (timeframe === 'this-year') {
      label = 'Year to Date';
      // Stop at the end of this month, so entries dated later in the year (e.g. rent entered early) don't count yet.
      const inYearToDate = (date: string | undefined) =>
        (date || '').startsWith(`${currentYear}-`) && (date || '').slice(0, 7) <= thisMonthKey;
      filteredPayments = filteredPayments.filter((p) => inYearToDate(p.payment_date));
      filteredExpenses = filteredExpenses.filter((e) => inYearToDate(e.expense_date));
    }

    const totalRevenue = filteredPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalExpenses = filteredExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const netProfit = totalRevenue - totalExpenses;
    const profitMargin = totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 100) : 0;

    // The headline "Active Members" count always reflects the current roster so
    // it matches the Members page. For past/rolling windows we count members
    // whose membership was active during that window instead — this is what
    // makes the month-over-month trend arrow meaningful.
    const currentActiveMembers = members.filter((m) => m.status === 'active').length;
    let activeMembers = currentActiveMembers;
    if (timeframe === 'last-month' || timeframe === 'last-month-to-date') {
      // Paid members who were "active" on the last day of last month: more than 7 days left, the same rule
      // as today's active status, so expiring members aren't counted on one side only.
      const lastDay = formatDateLocal(new Date(currentYear, currentMonth, 0));
      const activeCutoff = formatDateLocal(new Date(currentYear, currentMonth, 7));
      activeMembers = members.filter(
        (m) => m.status !== 'pending' && m.start_date && m.end_date && m.start_date <= lastDay && m.end_date > activeCutoff
      ).length;
    } else if (timeframe === 'last-3-months' || timeframe === 'last-6-months') {
      const count = timeframe === 'last-3-months' ? 3 : 6;
      const start = formatDateLocal(new Date(currentYear, currentMonth - (count - 1), 1));
      const end = formatDateLocal(new Date(currentYear, currentMonth + 1, 0));
      activeMembers = countMembersActiveInWindow(members, start, end);
    } else if (timeframe === 'this-year') {
      activeMembers = countMembersActiveInWindow(
        members,
        `${currentYear}-01-01`,
        formatDateLocal(now)
      );
    }
    const expiringMemberships = members.filter((m) => m.status === 'expiring').length;
    const expiredMemberships = members.filter((m) => m.status === 'expired').length;
    const inactiveMembers = members.filter((m) => m.status === 'inactive').length;
    const pendingMembers = members.filter((m) => m.status === 'pending').length;
    // Always from today's roster: the period counts above would otherwise add expiring and expired members twice.
    const totalMembers = currentActiveMembers + expiringMemberships + expiredMemberships + inactiveMembers + pendingMembers;
    const renewalRate = totalMembers > 0 ? Math.round((currentActiveMembers / totalMembers) * 1000) / 10 : 0;

    return {
      totalRevenue,
      totalExpenses,
      netProfit,
      activeMembers,
      expiringMemberships,
      expiredMemberships,
      renewalRate,
      profitMargin,
      periodLabel: label,
    };
  }

  // 8. Monthly Trends for Charts
  static getMonthlyTrends(months = 6): MonthlyTrendData[] {
    const payments = this.getPayments();
    const expenses = this.getExpenses();
    const members = this.getMembers();

    const buckets = getRecentMonthBuckets(months);

    return buckets.map(({ month, monthKey }) => {
      const key = monthKey;
      const revenue = payments
        .filter((p) => p.payment_status === 'completed' && (p.payment_date || '').startsWith(key))
        .reduce((sum, p) => sum + Number(p.amount), 0);
      const expenseTotal = expenses
        .filter((e) => (e.expense_date || '').startsWith(key))
        .reduce((sum, e) => sum + Number(e.amount), 0);
      const memberCount = members.filter((m) => (m.start_date || '') <= `${key}-31`).length;

      return {
        month,
        monthKey,
        revenue,
        expenses: expenseTotal,
        profit: revenue - expenseTotal,
        memberCount,
      };
    });
  }

  // 9. Historical Expense Analytics
  static getExpenseHistoryMonths(): { monthKey: string; monthLabel: string }[] {
    const expenses = this.getExpenses();
    const map = new Map<string, string>();

    // Always include current month and previous 5 months
    const recentBuckets = getRecentMonthBuckets(6);
    recentBuckets.forEach((b) => {
      const [y, m] = b.monthKey.split('-');
      const d = new Date(Number(y), Number(m) - 1, 1);
      map.set(b.monthKey, d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
    });

    // Also include any other month present in expense dates
    expenses.forEach((e) => {
      if (e.expense_date && e.expense_date.length >= 7) {
        const key = e.expense_date.slice(0, 7);
        if (!map.has(key)) {
          const [y, m] = key.split('-');
          const d = new Date(Number(y), Number(m) - 1, 1);
          map.set(key, d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
        }
      }
    });

    return Array.from(map.entries())
      .map(([monthKey, monthLabel]) => ({ monthKey, monthLabel }))
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }

  static getHistoricalExpenseSummary(): {
    categories: Record<string, { total: number; monthlyAvg: number; count: number; recentMonths: { month: string; amount: number }[] }>;
    monthlyTotals: { month: string; monthKey: string; total: number }[];
    overallMonthlyAverage: number;
  } {
    const expenses = this.getExpenses();
    const months = this.getExpenseHistoryMonths();
    // The last 6 calendar months, newest first; future-dated expenses don't push out a real past month.
    const monthKeys = getRecentMonthKeys(6).reverse();

    const monthlyTotals = monthKeys.map((key) => {
      const match = months.find((m) => m.monthKey === key);
      const total = expenses
        .filter((e) => (e.expense_date || '').startsWith(key))
        .reduce((sum, e) => sum + Number(e.amount), 0);
      return {
        monthKey: key,
        month: match ? match.monthLabel : key,
        total,
      };
    });

    const categories: Record<string, { total: number; monthlyAvg: number; count: number; recentMonths: { month: string; amount: number }[] }> = {};
    const catList = [
      'Rent', 'Utilities', 'Salaries', 'Equipment', 'Maintenance', 'Supplies', 'Marketing', 'Other'
    ];

    // Compute monthly average based on months that actually contain recorded expenses
    const recordedMonthKeys = monthKeys.filter((key) =>
      expenses.some((e) => (e.expense_date || '').startsWith(key))
    );
    const divisor = recordedMonthKeys.length || 1;

    catList.forEach((cat) => {
      const catExpenses = expenses.filter((e) => e.category === cat);
      const total = catExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
      const recentMonths = monthKeys.map((key) => {
        const match = months.find((m) => m.monthKey === key);
        const amount = catExpenses
          .filter((e) => (e.expense_date || '').startsWith(key))
          .reduce((sum, e) => sum + Number(e.amount), 0);
        return {
          month: match ? match.monthLabel : key,
          amount,
        };
      });

      // Average only the spending inside the 6-month window, over the same months as the divisor.
      const windowTotal = recentMonths.reduce((sum, m) => sum + m.amount, 0);
      categories[cat] = {
        total,
        monthlyAvg: Math.round(windowTotal / divisor),
        count: catExpenses.length,
        recentMonths,
      };
    });

    const overallTotal = monthlyTotals.reduce((sum, m) => sum + m.total, 0);
    const overallMonthlyAverage = Math.round(overallTotal / divisor);

    return {
      categories,
      monthlyTotals,
      overallMonthlyAverage,
    };
  }
}
