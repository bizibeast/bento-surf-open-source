import { usernameSchema } from "./username";

type ExistingProfile = { id: string } | null;
type FindExistingUsername = (username: string) => Promise<ExistingProfile>;
type LogError = (message: string, error: unknown) => void;

export async function checkUsernameAvailability(
  username: string,
  findExisting: FindExistingUsername,
  logError: LogError = console.error,
) {
  const normalizedUsername = usernameSchema.parse(username);
  try {
    const existing = await findExisting(normalizedUsername);
    return { available: existing === null };
  } catch (error) {
    logError("Username availability lookup failed", error);
    throw new Error("Unable to check username availability");
  }
}
