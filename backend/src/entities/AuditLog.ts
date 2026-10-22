import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index
} from "typeorm";

@Entity("audit_log")
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  @Index("IDX_audit_log_action")
  action!: string;

  @CreateDateColumn({ name: "performed_at", type: "timestamptz" })
  performedAt!: Date;

  @Column({ name: "ip_hash", type: "varchar", length: 16 })
  ipHash!: string;

  @Column({ name: "request_id", type: "varchar", length: 64 })
  requestId!: string;

  /**
   * Issue #1262: The authenticated actor (user wallet address or service
   * identifier) that performed the privileged operation. Null for unauthenticated
   * or system-level events where no principal is available.
   */
  @Column({ name: "actor", type: "varchar", length: 128, nullable: true })
  actor!: string | null;

  /**
   * Issue #1262: Stable outcome label for the audited operation.
   * One of: `success`, `failure`, `blocked`.
   */
  @Column({ name: "outcome", type: "varchar", length: 32, nullable: true })
  outcome!: string | null;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;
}
