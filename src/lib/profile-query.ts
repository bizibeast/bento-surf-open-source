export const UPDATE_PROFILE_ERROR = "Unable to update profile";
export const PUBLIC_PROFILE_READ_ERROR = "Unable to load public profile";
export const USERNAME_CHANGE_COOLDOWN_ERROR = "Username can only be changed once every 30 days.";

interface DatabaseError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface QueryResult<T> {
  data: T | null;
  error: DatabaseError | null;
}

type ErrorLogger = (message: string, error: unknown) => void;

export async function updateProfileWithRls<T, TUpdates>(
  userId: string,
  updates: TUpdates,
  update: (userId: string, updates: TUpdates) => PromiseLike<QueryResult<T>>,
  logError: ErrorLogger = console.error,
): Promise<T> {
  let result: QueryResult<T>;
  try {
    result = await update(userId, updates);
  } catch (error) {
    logError("Profile update failed", error);
    throw new Error(UPDATE_PROFILE_ERROR);
  }

  if (result.error) {
    logError("Profile update failed", result.error);
    if (result.error.code === "23505") throw new Error("Username already taken");
    if (result.error.code === "23514" && result.error.message === USERNAME_CHANGE_COOLDOWN_ERROR) {
      throw new Error(USERNAME_CHANGE_COOLDOWN_ERROR);
    }
    throw new Error(UPDATE_PROFILE_ERROR);
  }

  if (result.data === null) {
    const error = new Error("Profile update returned no data");
    logError("Profile update failed", error);
    throw new Error(UPDATE_PROFILE_ERROR);
  }

  return result.data;
}

export function readPublicProfileResult<T>(
  resource: "profile" | "pages" | "blocks",
  result: QueryResult<T>,
  logError: ErrorLogger = console.error,
): T | null {
  if (result.error) {
    logError(`Public profile ${resource} query failed`, result.error);
    throw new Error(PUBLIC_PROFILE_READ_ERROR);
  }
  return result.data;
}
