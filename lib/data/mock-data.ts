import {
  UserProfile,
  Gym,
  StaffMember,
  MembershipPlan,
  Member,
  Payment,
  Expense,
  AttendanceLog,
  AuditLogEntry,
  GymRole,
} from '@/types/database';
import { getTodayKey, toDateKey, daysAgoKey, getRecentMonthKeys } from '@/lib/ui/date';

export const INITIAL_PROFILE: UserProfile = {
  id: '',
  email: '',
  full_name: 'Justine Cyrus Cabato',
  role: 'admin',
  gym_name: 'IronPeak Fitness Club',
  currency: '₱',
  phone: '+63 917 123 4567',
  created_at: new Date().toISOString(),
};

export interface GymData {
  userId: string | null;
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

export function getDemoGymData(): GymData {
  const today = getTodayKey();
  const userId = 'demo-owner-justine';
  const gymId = 'demo-gym-ironpeak';

  const profile: UserProfile = {
    id: userId,
    email: 'justinecyruscabato@gmail.com',
    full_name: 'Justine Cyrus Cabato',
    role: 'owner',
    gym_name: 'IronPeak Fitness Club',
    currency: '₱',
    phone: '+63 917 123 4567',
    created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
  };

  const gym: Gym = {
    id: gymId,
    owner_id: userId,
    name: 'IronPeak Fitness Club',
    address: '123 Rizal Avenue, Brgy. San Roque, Quezon City',
    phone: '+63 917 123 4567',
    email: 'justinecyruscabato@gmail.com',
    currency: '₱',
    opening_hours: {
      mon: { open: '06:00', close: '22:00', closed: false },
      tue: { open: '06:00', close: '22:00', closed: false },
      wed: { open: '06:00', close: '22:00', closed: false },
      thu: { open: '06:00', close: '22:00', closed: false },
      fri: { open: '06:00', close: '22:00', closed: false },
      sat: { open: '07:00', close: '20:00', closed: false },
      sun: { open: '08:00', close: '17:00', closed: true },
    },
    walk_in_price: 100,
    logo_url: null,
    onboarded_at: new Date(Date.now() - 180 * 86400000).toISOString(),
    created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
  };

  const staff: StaffMember[] = [
    {
      id: 'staff-1',
      gym_id: gymId,
      user_id: 'staff-u1',
      email: 'reception@ironpeak.ph',
      full_name: 'Maria Santos',
      role: 'staff',
      status: 'active',
      created_at: new Date(Date.now() - 120 * 86400000).toISOString(),
    },
  ];

  const plans: MembershipPlan[] = [
    {
      id: 'plan-1',
      admin_id: userId,
      name: 'Monthly Regular',
      price: 1500,
      duration_months: 1,
      description: 'Full access to gym equipment and locker rooms',
      is_active: true,
      created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
    },
    {
      id: 'plan-2',
      admin_id: userId,
      name: 'Quarterly Pro',
      price: 4200,
      duration_months: 3,
      description: 'Includes group classes and free fitness assessment',
      is_active: true,
      created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
    },
    {
      id: 'plan-3',
      admin_id: userId,
      name: 'Annual VIP Access',
      price: 15000,
      duration_months: 12,
      description: 'Unlimited access, free sauna, and guest passes',
      is_active: true,
      created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
    },
    {
      id: 'plan-4',
      admin_id: userId,
      name: 'Student Monthly Discount',
      price: 1100,
      duration_months: 1,
      description: 'Valid student ID required. Gym hours 6AM - 5PM',
      is_active: true,
      created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
    },
  ];

  // Helper date calculators
  const offsetDate = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return toDateKey(d);
  };

  const rawMembers = [
    { id: 'm-1', fn: 'Juan', ln: 'Dela Cruz', planId: 'plan-1', status: 'active' as const, endOffset: 20, lastVisitOffset: 0, method: 'Cash' as const },
    { id: 'm-2', fn: 'Maria', ln: 'Santos', planId: 'plan-1', status: 'active' as const, endOffset: 12, lastVisitOffset: 1, method: 'GCash' as const },
    { id: 'm-3', fn: 'Mark', ln: 'Reyes', planId: 'plan-1', status: 'active' as const, endOffset: 25, lastVisitOffset: 0, method: 'Cash' as const },
    { id: 'm-4', fn: 'Angelica', ln: 'Bautista', planId: 'plan-1', status: 'expiring' as const, endOffset: 3, lastVisitOffset: 2, method: 'GCash' as const },
    { id: 'm-5', fn: 'Paolo', ln: 'Garcia', planId: 'plan-1', status: 'active' as const, endOffset: 15, lastVisitOffset: 1, method: 'Cash' as const },
    { id: 'm-6', fn: 'Kristine', ln: 'Mendoza', planId: 'plan-1', status: 'expiring' as const, endOffset: 5, lastVisitOffset: 3, method: 'GCash' as const },
    { id: 'm-7', fn: 'Ramon', ln: 'Villanueva', planId: 'plan-1', status: 'expired' as const, endOffset: -10, lastVisitOffset: 22, method: 'Cash' as const },
    { id: 'm-8', fn: 'Bea', ln: 'Navarro', planId: 'plan-4', status: 'expiring' as const, endOffset: 4, lastVisitOffset: 1, method: 'GCash' as const },
    { id: 'm-9', fn: 'Carlo', ln: 'Aquino', planId: 'plan-4', status: 'expiring' as const, endOffset: 2, lastVisitOffset: 2, method: 'Cash' as const },
    { id: 'm-10', fn: 'Janine', ln: 'Flores', planId: 'plan-4', status: 'expired' as const, endOffset: -18, lastVisitOffset: 30, method: 'GCash' as const },
    { id: 'm-11', fn: 'Miguel', ln: 'Torres', planId: 'plan-2', status: 'active' as const, endOffset: 40, lastVisitOffset: 1, method: 'Cash' as const },
    { id: 'm-12', fn: 'Patricia', ln: 'Lim', planId: 'plan-2', status: 'active' as const, endOffset: 15, lastVisitOffset: 2, method: 'GCash' as const },
    { id: 'm-13', fn: 'Joshua', ln: 'Ramos', planId: 'plan-2', status: 'active' as const, endOffset: 30, lastVisitOffset: 18, method: 'Cash' as const },
    { id: 'm-14', fn: 'Andrea', ln: 'Castillo', planId: 'plan-2', status: 'active' as const, endOffset: 70, lastVisitOffset: 3, method: 'GCash' as const },
    { id: 'm-15', fn: 'Daniel', ln: 'Cruz', planId: 'plan-3', status: 'active' as const, endOffset: 320, lastVisitOffset: 0, method: 'Cash' as const },
    { id: 'm-16', fn: 'Liza', ln: 'Manalo', planId: 'plan-1', status: 'pending' as const, endOffset: 30, lastVisitOffset: 0, method: 'Cash' as const },
  ];

  const members: Member[] = rawMembers.map((m) => {
    const plan = plans.find((p) => p.id === m.planId) || plans[0];
    const startDate = offsetDate(m.endOffset - plan.duration_months * 30);
    const endDate = offsetDate(m.endOffset);
    const lastVisit = offsetDate(-m.lastVisitOffset);

    return {
      id: m.id,
      admin_id: userId,
      first_name: m.fn,
      last_name: m.ln,
      email: `${m.fn.toLowerCase()}.${m.ln.toLowerCase()}@gmail.com`,
      phone: `0917${Math.floor(1000000 + Math.random() * 9000000)}`,
      emergency_contact: '09181234567',
      membership_plan_id: m.planId,
      plan,
      start_date: startDate,
      end_date: endDate,
      status: m.status,
      last_visit_date: lastVisit,
      notes: 'Active fitness enthusiast',
      created_at: new Date(startDate).toISOString(),
    };
  });

  // Generate 6 months of historical payments
  const recentMonths = getRecentMonthKeys(6);
  const payments: Payment[] = [];
  let paymentIdCounter = 1;

  recentMonths.forEach((mKey, monthIndex) => {
    const isCurrent = monthIndex === recentMonths.length - 1;
    const baseCount = isCurrent ? 8 : 12;

    for (let i = 0; i < baseCount; i++) {
      const member = members[i % members.length];
      const plan = plans.find((p) => p.id === member.membership_plan_id) || plans[0];
      const day = String(Math.min(28, (i * 2) + 1)).padStart(2, '0');
      const payDate = `${mKey}-${day}`;
      const isGCash = i % 2 === 1;

      // Make 2 recent GCash payments unverified to demonstrate the "Needs Verification" queue!
      const isNeedsVerification = isCurrent && i === 1;

      payments.push({
        id: `pay-${paymentIdCounter++}`,
        admin_id: userId,
        member_id: member.id,
        member_name: `${member.first_name} ${member.last_name}`,
        membership_plan_id: plan.id,
        plan,
        amount: plan.price,
        payment_date: payDate,
        payment_method: isGCash ? 'GCash' : 'Cash',
        payment_status: 'completed',
        receipt_status: isNeedsVerification ? 'unverified' : 'verified',
        reference_number: isGCash ? `102938${1000000 + paymentIdCounter}` : undefined,
        verified_at: isNeedsVerification ? undefined : new Date(payDate).toISOString(),
        verified_by: isNeedsVerification ? undefined : 'Justine Cyrus Cabato',
        is_walk_in: false,
        created_at: new Date(payDate).toISOString(),
      });
    }

    // Add 3 walk-in payments per month
    ['Jomar Pascual', 'Ella Dizon', 'Rico Salazar'].forEach((wName, wIdx) => {
      const wDay = String(5 + wIdx * 7).padStart(2, '0');
      payments.push({
        id: `pay-${paymentIdCounter++}`,
        admin_id: userId,
        member_id: '',
        member_name: wName,
        amount: 100,
        payment_date: `${mKey}-${wDay}`,
        payment_method: wIdx % 2 === 0 ? 'Cash' : 'GCash',
        payment_status: 'completed',
        receipt_status: 'verified',
        reference_number: wIdx % 2 === 1 ? `102948${9000000 + paymentIdCounter}` : undefined,
        is_walk_in: true,
        created_at: new Date(`${mKey}-${wDay}`).toISOString(),
      });
    });
  });

  // Categorized monthly expenses
  const expenses: Expense[] = [];
  let expIdCounter = 1;

  recentMonths.forEach((mKey, monthIndex) => {
    const isCurrent = monthIndex === recentMonths.length - 1;
    // Power bill slightly higher in current month to trigger the expense leak tip
    const electricAmount = isCurrent ? 38400 : 24000;

    expenses.push(
      {
        id: `exp-${expIdCounter++}`,
        admin_id: userId,
        category: 'Rent',
        title: 'Gym Space Commercial Lease',
        amount: 45000,
        expense_date: `${mKey}-05`,
        payment_method: 'GCash',
        description: 'Monthly commercial rental payment',
        created_at: new Date(`${mKey}-05`).toISOString(),
      },
      {
        id: `exp-${expIdCounter++}`,
        admin_id: userId,
        category: 'Utilities & Power',
        title: 'Meralco Electric Bill',
        amount: electricAmount,
        expense_date: `${mKey}-12`,
        payment_method: 'GCash',
        description: 'Facility lighting and air conditioning units',
        created_at: new Date(`${mKey}-12`).toISOString(),
      },
      {
        id: `exp-${expIdCounter++}`,
        admin_id: userId,
        category: 'Staff Payroll',
        title: 'Front-Desk and Trainer Salaries',
        amount: 22000,
        expense_date: `${mKey}-15`,
        payment_method: 'Cash',
        description: 'Mid-month staff compensation',
        created_at: new Date(`${mKey}-15`).toISOString(),
      },
      {
        id: `exp-${expIdCounter++}`,
        admin_id: userId,
        category: 'Equipment Maintenance',
        title: 'Treadmill Belts & Cable Lubrication',
        amount: 3500,
        expense_date: `${mKey}-18`,
        payment_method: 'Cash',
        description: 'Preventive monthly maintenance on cardiovascular equipment',
        created_at: new Date(`${mKey}-18`).toISOString(),
      },
      {
        id: `exp-${expIdCounter++}`,
        admin_id: userId,
        category: 'Gym Supplies',
        title: 'Cleaning Solvents & Paper Towels',
        amount: 1800,
        expense_date: `${mKey}-20`,
        payment_method: 'Cash',
        description: 'Sanitizing supplies for weight room equipment',
        created_at: new Date(`${mKey}-20`).toISOString(),
      }
    );
  });

  // Attendance check-ins for today (so today check-in counter shows 6)
  const attendance: AttendanceLog[] = [
    { id: 'att-1', gym_id: gymId, member_id: 'm-1', check_in_time: `${today}T06:30:00+08:00`, created_at: `${today}T06:30:00+08:00` },
    { id: 'att-2', gym_id: gymId, member_id: 'm-2', check_in_time: `${today}T07:15:00+08:00`, created_at: `${today}T07:15:00+08:00` },
    { id: 'att-3', gym_id: gymId, member_id: 'm-3', check_in_time: `${today}T07:45:00+08:00`, created_at: `${today}T07:45:00+08:00` },
    { id: 'att-4', gym_id: gymId, member_id: 'm-5', check_in_time: `${today}T08:10:00+08:00`, created_at: `${today}T08:10:00+08:00` },
    { id: 'att-5', gym_id: gymId, member_id: 'm-11', check_in_time: `${today}T09:00:00+08:00`, created_at: `${today}T09:00:00+08:00` },
    { id: 'att-6', gym_id: gymId, member_id: 'm-15', check_in_time: `${today}T09:30:00+08:00`, created_at: `${today}T09:30:00+08:00` },
  ];

  // Audit log entries
  const audit: AuditLogEntry[] = [
    {
      id: 'aud-1',
      gym_id: gymId,
      user_id: userId,
      user_email: 'justinecyruscabato@gmail.com',
      action: 'payment.receipt_verify',
      entity_type: 'payment',
      entity_id: 'pay-2',
      entity_label: 'Juan Dela Cruz - ₱1,500',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'aud-2',
      gym_id: gymId,
      user_id: 'staff-u1',
      user_email: 'reception@ironpeak.ph',
      action: 'attendance.check_in',
      entity_type: 'attendance',
      entity_id: 'att-1',
      entity_label: 'Juan Dela Cruz Check-In',
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
  ];

  return {
    userId,
    profile,
    gym,
    role: 'owner',
    staff,
    plans,
    members,
    payments,
    expenses,
    attendance,
    audit,
  };
}
