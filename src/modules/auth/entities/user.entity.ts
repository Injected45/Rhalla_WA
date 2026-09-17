import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ApiKeyRole } from './api-key.entity';

/**
 * A dashboard/tenant account.
 *
 * Lives on the 'main' TypeORM connection, which is ALWAYS SQLite with
 * synchronize: true — so this table is created automatically and must use
 * plain column types only (no jsonColumnType()/dateColumnType()/DateTransformer,
 * which are for the pluggable 'data' connection).
 *
 * Roles reuse ApiKeyRole so a user and the API key issued to it share one
 * permission hierarchy (see AuthService.hasPermission).
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Always stored lowercase — UserService normalises before read/write. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 64 })
  passwordSalt: string;

  @Column({ type: 'varchar', length: 150, nullable: true })
  fullName: string | null;

  @Column({ type: 'varchar', length: 20, default: ApiKeyRole.OPERATOR })
  role: ApiKeyRole;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /** Concurrent WhatsApp session quota. 0 = unlimited. */
  @Column({ type: 'int', default: 1 })
  maxSessions: number;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
