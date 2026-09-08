import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createCustomSkillInputSchema,
  CUSTOM_SKILL_MAX_COUNT,
  type CreateCustomSkillInput,
} from '@roomote/types';
import { db } from '../db';
import { instanceSkills, users } from '../schema';

export class CreateCustomSkillError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function requireMember(tx: Transaction, actorUserId: string) {
  const [actor] = actorUserId
    ? await tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, actorUserId), isNull(users.deletedAt)))
        .for('share')
    : [];
  if (!actor)
    throw new CreateCustomSkillError('Active member access required', 403);
  return actor;
}

async function readSkill(tx: Transaction, skillId: string) {
  if (!z.string().uuid().safeParse(skillId).success)
    throw new CreateCustomSkillError('Skill not found', 404);
  const [skill] = await tx
    .select()
    .from(instanceSkills)
    .where(eq(instanceSkills.id, skillId))
    .for('update');
  if (!skill) throw new CreateCustomSkillError('Skill not found', 404);
  return skill;
}

function duplicateError(error: unknown): never {
  let current = error;
  while (current && typeof current === 'object') {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === 'instance_skills_name_unique_idx'
    ) {
      throw new CreateCustomSkillError(
        'A skill with this name already exists. Choose another name or edit it in Settings.',
        409,
      );
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  throw error;
}

export async function listCustomSkills(actorUserId: string) {
  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, actorUserId);
    const skills = await tx
      .select()
      .from(instanceSkills)
      .orderBy(asc(instanceSkills.name));
    return skills.map((skill) => ({
      ...skill,
      canManage: actor.role === 'admin' || skill.createdByUserId === actor.id,
    }));
  });
}

export async function getCustomSkill(actorUserId: string, skillId: string) {
  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, actorUserId);
    const skill = await readSkill(tx, skillId);
    return {
      ...skill,
      canManage: actor.role === 'admin' || skill.createdByUserId === actor.id,
    };
  });
}

export async function createCustomSkill(
  input: CreateCustomSkillInput & { actorUserId: string },
) {
  return db
    .transaction(async (tx) => {
      const { actorUserId, ...definition } = input;
      const actor = await requireMember(tx, actorUserId);
      const skill = createCustomSkillInputSchema.parse(definition);
      // One logical instance per DB. Serialize count + insert so concurrent creates cannot exceed the cap.
      await tx.execute(sql`select pg_advisory_xact_lock(1936419180, 1)`);
      const [total] = await tx.select({ value: count() }).from(instanceSkills);
      if (total!.value >= CUSTOM_SKILL_MAX_COUNT)
        throw new CreateCustomSkillError(
          'The instance skill limit has been reached (128).',
          409,
        );
      const [created] = await tx
        .insert(instanceSkills)
        .values({ ...skill, createdByUserId: actor.id })
        .returning();
      return {
        success: true as const,
        persisted: true as const,
        skillId: created!.id,
        name: created!.name,
        scope: 'instance' as const,
      };
    })
    .catch(duplicateError);
}

export async function updateCustomSkill(
  input: CreateCustomSkillInput & { actorUserId: string; skillId: string },
) {
  return db
    .transaction(async (tx) => {
      const { actorUserId, skillId, ...definition } = input;
      const actor = await requireMember(tx, actorUserId);
      const skill = await readSkill(tx, skillId);
      if (actor.role !== 'admin' && skill.createdByUserId !== actor.id)
        throw new CreateCustomSkillError(
          'Only the creator or an admin can manage this skill',
          403,
        );
      const parsed = createCustomSkillInputSchema.parse(definition);
      await tx
        .update(instanceSkills)
        .set({ ...parsed, updatedAt: new Date() })
        .where(eq(instanceSkills.id, skillId));
      return {
        success: true as const,
        persisted: true as const,
        skillId,
        name: parsed.name,
        scope: 'instance' as const,
      };
    })
    .catch(duplicateError);
}

export async function deleteCustomSkill(input: {
  actorUserId: string;
  skillId: string;
}) {
  return db.transaction(async (tx) => {
    const { actorUserId, skillId } = z
      .object({ actorUserId: z.string(), skillId: z.string() })
      .strict()
      .parse(input);
    const actor = await requireMember(tx, actorUserId);
    const skill = await readSkill(tx, skillId);
    if (actor.role !== 'admin' && skill.createdByUserId !== actor.id)
      throw new CreateCustomSkillError(
        'Only the creator or an admin can manage this skill',
        403,
      );
    await tx.delete(instanceSkills).where(eq(instanceSkills.id, skillId));
    return { success: true as const };
  });
}

/** Internal trusted caller only: SDK must first authenticate a signed, nonterminal run bound to this DB. */
export async function listInstanceSkillDefinitions(): Promise<
  Array<{ name: string; description: string; content: string }>
> {
  return db
    .select({
      name: instanceSkills.name,
      description: instanceSkills.description,
      content: instanceSkills.content,
    })
    .from(instanceSkills)
    .orderBy(asc(instanceSkills.name));
}
