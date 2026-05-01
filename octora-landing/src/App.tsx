import { GlowBackground } from "./components/GlowBackground";
import { FloatingParticles } from "./components/FloatingParticles";
import { HeroSection } from "./components/HeroSection";
import { DemoPreview } from "./components/DemoPreview";
import { WhyOctora } from "./components/WhyOctora";
import { PartnerMarquee } from "./components/PartnerMarquee";
import { HowItWorks } from "./components/HowItWorks";
import { MetricsBar } from "./components/MetricsBar";
import { WaitlistForm } from "./components/WaitlistForm";
import { FaqSection } from "./components/FaqSection";
import { Footer } from "./components/Footer";

function App() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-base font-sans text-white antialiased select-none">
      <GlowBackground />
      <FloatingParticles count={35} />

      <main className="relative z-10">
        <HeroSection />
        <MetricsBar />
        <DemoPreview />
        <WhyOctora />
        <HowItWorks />
        <PartnerMarquee />
        <WaitlistForm />
        <FaqSection />
      </main>

      <Footer />
    </div>
  );
}

export default App;
