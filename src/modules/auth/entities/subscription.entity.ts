import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum SubscriptionPlan {
  TRIAL = 'trial',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
  MANUAL = 'manual',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/**
 * Single source of truth for plan lengths, in days.
 * `manual` has no fixed length: the caller supplies expiresAt, or null for
 * an unlimited subscription. Any plan can be overridden with an explicit
 * `days` value when it is assigned.
 */
export const PLAN_DURATION_DAYS: Record<SubscriptionPlan, number | null> = {
  [SubscriptionPlan.TRIAL]: 3,
  [SubscriptionPlan.WEEK]: 7,
  [SubscriptionPlan.MONTH]: 30,
  [SubscriptionPlan.YEAR]: 365,
  [SubscriptionPlan.MANUAL]: null,
};

/**
 * One row per subscription grant — append-only history.
 *
 * Rows are never overwritten: assigning a new subscription cancels the
 * previous active row and inserts a new one. A user's *effective*
 * subscription is the newest row with status 'active'.
 *
 * On the 'main' (always SQLite) connection — plain column types only.
 */
@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  userId: string;

  @Column({ type: 'varchar', length: 20, default: SubscriptionPlan.TRIAL })
  plan: SubscriptionPlan;

  @Column({ type: 'datetime' })
  startsAt: Date;

  /** null = never expires. */
  @Column({ type: 'datetime', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'varchar', length: 20, default: SubscriptionStatus.ACTIVE })
  status: SubscriptionStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
