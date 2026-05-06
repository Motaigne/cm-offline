import { redirect } from 'next/navigation';

// Onboarding is now handled by /profil
export default function OnboardingPage() {
  redirect('/profil');
}
