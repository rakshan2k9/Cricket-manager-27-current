import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { managerProfiles, users } from './schema.ts';

export async function getOrCreateUser(uid: string, email: string) {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    console.error('Database error in getOrCreateUser:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

export async function getManagerProfile(userUid: string) {
  try {
    const rows = await db
      .select()
      .from(managerProfiles)
      .where(eq(managerProfiles.userUid, userUid))
      .limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database error in getManagerProfile:', error);
    throw new Error('Failed to load manager profile.', { cause: error });
  }
}

export async function upsertManagerProfile(input: {
  userUid: string;
  managerName: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  country: string;
  preferredCurrency?: string;
  birthYear?: number;
  birthMonth?: string;
  birthDay?: number;
  coachExperience?: string;
  coachBackground?: string;
  coachingStyle?: string;
  favoriteFormat: string;
  avatarUrl: string;
  bio?: string;
}) {
  try {
    const cleanFirst = (input.firstName ?? '').trim();
    const cleanLast = (input.lastName ?? '').trim();
    const cleanPreferred = (input.preferredName ?? '').trim();
    const derivedName =
      input.managerName.trim() ||
      cleanPreferred ||
      [cleanFirst, cleanLast].filter(Boolean).join(' ') ||
      'Manager';

    const payload = {
      managerName: derivedName,
      firstName: cleanFirst,
      lastName: cleanLast,
      preferredName: cleanPreferred || derivedName,
      country: input.country.trim(),
      preferredCurrency: input.preferredCurrency || 'INR',
      birthYear: Number(input.birthYear) || 1993,
      birthMonth: (input.birthMonth || 'MAY').toUpperCase(),
      birthDay: Math.max(1, Math.min(31, Number(input.birthDay) || 7)),
      coachExperience: input.coachExperience || 'Regional Experience',
      coachBackground: input.coachBackground || 'Tactical Analyst',
      coachingStyle: input.coachingStyle || 'Balanced Tactical',
      favoriteFormat: input.favoriteFormat,
      avatarUrl: input.avatarUrl,
      bio: input.bio?.trim() ?? '',
      updatedAt: new Date(),
    };

    const result = await db
      .insert(managerProfiles)
      .values({
        userUid: input.userUid,
        ...payload,
      })
      .onConflictDoUpdate({
        target: managerProfiles.userUid,
        set: payload,
      })
      .returning();
    return result[0];
  } catch (error) {
    console.error('Database error in upsertManagerProfile:', error);
    throw new Error('Failed to save manager profile.', { cause: error });
  }
}
