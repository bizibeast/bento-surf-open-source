import { useCallback, useEffect, useRef, useState } from "react";
import { usernameSchema } from "./username";

type AvailabilityResult = { available: boolean };
type CheckUsername = (username: string) => Promise<AvailabilityResult>;

export function useUsernameAvailability(
  checkUsername: CheckUsername,
  delayMs = 350,
  currentUsername?: string | null,
) {
  const [username, setUsernameState] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestVersion = useRef(0);
  const usernameRef = useRef("");

  const setUsername = useCallback((nextUsername: string) => {
    if (usernameRef.current === nextUsername) return;
    usernameRef.current = nextUsername;
    requestVersion.current += 1;
    setAvailable(null);
    setAvailabilityError(false);
    setUsernameState(nextUsername);
  }, []);

  const retry = useCallback(() => {
    if (!usernameSchema.safeParse(usernameRef.current).success) return;
    requestVersion.current += 1;
    setAvailable(null);
    setAvailabilityError(false);
    setRetryVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) return;

    const version = ++requestVersion.current;
    const parsedCurrentUsername = usernameSchema.safeParse(currentUsername);
    if (parsedCurrentUsername.success && parsed.data === parsedCurrentUsername.data) {
      setAvailable(true);
      setAvailabilityError(false);
      return;
    }

    setAvailable(null);
    setAvailabilityError(false);
    const timer = window.setTimeout(async () => {
      try {
        const result = await checkUsername(parsed.data);
        if (requestVersion.current === version) setAvailable(result.available);
      } catch {
        if (requestVersion.current === version) {
          setAvailable(null);
          setAvailabilityError(true);
        }
      }
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [checkUsername, currentUsername, delayMs, retryVersion, username]);

  return { username, setUsername, available, availabilityError, retry };
}
