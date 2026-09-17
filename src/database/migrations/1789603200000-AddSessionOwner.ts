import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.ownerUserId` — the user account a WhatsApp session belongs to.
 *
 * The `users` table lives on the 'main' connection (always SQLite), while
 * `sessions` lives on the pluggable 'data' connection, so this is deliberately
 * a plain varchar with an index and NO foreign key: the two tables can be in
 * different databases entirely.
 *
 * Existing rows are left NULL here and backfilled to the seeded admin account
 * by UserService on boot, because this migration cannot read the users table
 * on the other connection. NULL is treated as "system/admin owned" and is
 * exempt from per-account session quotas, so an un-backfilled row is safe.
 *
 * Driver-branching is required: SQLite and Postgres disagree on both the
 * timestamp/boolean literals and the index syntax.
 */
export class AddSessionOwner1789603200000 implements MigrationInterface {
  name = 'AddSessionOwner1789603200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('sessions');
    if (!table) return;
    if (table.findColumnByName('ownerUserId')) return;

    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(36)`);
      await queryRunner.query(`CREATE INDEX "IDX_sessions_ownerUserId" ON "sessions" ("ownerUserId")`);
    } else {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(36)`);
      await queryRunner.query(`CREATE INDEX "IDX_sessions_ownerUserId" ON "sessions" ("ownerUserId") `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('sessions');
    if (!table) return;
    if (!table.findColumnByName('ownerUserId')) return;

    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_ownerUserId"`);
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "ownerUserId"`);
    } else {
      // SQLite < 3.35 cannot DROP COLUMN; the index goes either way and the
      // column is nullable, so leaving it in place is harmless on old builds.
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_ownerUserId"`);
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "ownerUserId"`);
    }
  }
}
