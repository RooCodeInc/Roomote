import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createCustomSkillInputSchema,
  CUSTOM_SKILL_MAX_COUNT,
  type CreateCustomSkillInput,
  type UpdateCustomSkillInput,
  updateCustomSkillInputSchema,
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
      .select({
        skill: instanceSkills,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(instanceSkills)
      .leftJoin(users, eq(users.id, instanceSkills.createdByUserId))
      .orderBy(asc(instanceSkills.name));
    return skills.map(({ skill, createdByName, createdByEmail }) => ({
      ...skill,
      createdByName: createdByName || createdByEmail || null,
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
  input: CreateCustomSkillInput & {
    actorUserId: string;
    expectedVersion: number;
    skillId: string;
  },
) {
  return db
    .transaction(async (tx) => {
      const { actorUserId, expectedVersion, skillId, ...definition } = input;
      const parsedExpectedVersion = z
        .number()
        .int()
        .positive()
        .parse(expectedVersion);
      const actor = await requireMember(tx, actorUserId);
      const skill = await readSkill(tx, skillId);
      if (actor.role !== 'admin' && skill.createdByUserId !== actor.id)
        throw new CreateCustomSkillError(
          'Only the creator or an admin can manage this skill',
          403,
        );
      if (skill.version !== parsedExpectedVersion)
        throw new CreateCustomSkillError(
          `Skill version conflict. Current version is ${skill.version}. Reload the skill and retry.`,
          409,
        );
      const parsed = createCustomSkillInputSchema.parse(definition);
      await tx
        .update(instanceSkills)
        .set({
          ...parsed,
          version: sql`${instanceSkills.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(instanceSkills.id, skillId));
      return {
        success: true as const,
        persisted: true as const,
        skillId,
        name: parsed.name,
        scope: 'instance' as const,
        version: skill.version + 1,
      };
    })
    .catch(duplicateError);
}

function replaceExact(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAllMatches: boolean,
): string {
  const matches = content.split(oldStr).length - 1;
  if (matches === 0)
    throw new CreateCustomSkillError(
      'old_str was not found in the skill content',
      409,
    );
  if (matches > 1 && !replaceAllMatches)
    throw new CreateCustomSkillError(
      'old_str matched multiple locations; set replace_all_matches to true to replace all matches',
      409,
    );
  return replaceAllMatches
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);
}

export async function updateCustomSkillFromAgent(
  input: UpdateCustomSkillInput & { actorUserId: string },
) {
  return db
    .transaction(async (tx) => {
      const { actorUserId, ...request } = input;
      const parsed = updateCustomSkillInputSchema.parse(request);
      const skillId = parsed.skillId.slice('instance:'.length);
      const actor = await requireMember(tx, actorUserId);
      const skill = await readSkill(tx, skillId);
      if (actor.role !== 'admin' && skill.createdByUserId !== actor.id)
        throw new CreateCustomSkillError(
          'Only the creator or an admin can manage this skill',
          403,
        );
      if (skill.version !== parsed.expectedVersion)
        throw new CreateCustomSkillError(
          `Skill version conflict. Current version is ${skill.version}. Reload the skill and retry.`,
          409,
        );

      let content = skill.content;
      if (parsed.content?.type === 'replace_content') {
        content = parsed.content.replace_content.new_str;
      } else if (parsed.content?.type === 'update_content') {
        for (const update of parsed.content.update_content.content_updates) {
          content = replaceExact(
            content,
            update.old_str,
            update.new_str,
            update.replace_all_matches ?? false,
          );
        }
      }
      const definition = createCustomSkillInputSchema.parse({
        name: parsed.name ?? skill.name,
        description: parsed.description ?? skill.description,
        content,
      });
      const version = skill.version + 1;
      await tx
        .update(instanceSkills)
        .set({ ...definition, version, updatedAt: new Date() })
        .where(eq(instanceSkills.id, skillId));
      return {
        success: true as const,
        persisted: true as const,
        skillId: parsed.skillId,
        name: definition.name,
        scope: 'instance' as const,
        version,
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
