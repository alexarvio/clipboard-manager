import { AuthGate } from "clipboard-manager";

export function Default() {
  return <AuthGate onAuthenticated={() => {}} />;
}
