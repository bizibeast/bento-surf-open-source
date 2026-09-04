import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export function useAuthSession() {
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const checkUser = async () => {
      const { data } = await supabase.auth.getSession();
      if (!cancelled) setHasSession(!!data.session?.user);
    };

    void checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(!!session?.user);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return { hasSession, isCheckingAuth: hasSession === null };
}
