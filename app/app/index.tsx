import { Redirect, type Href } from "expo-router";

import { useAuth } from "../src/auth/AuthProvider";

/** The app starts at "/". It has no page of its own. */
export default function Index() {
  const { status } = useAuth();
  return <Redirect href={(status === "signedOut" ? "/login" : "/spending") as Href} />;
}
