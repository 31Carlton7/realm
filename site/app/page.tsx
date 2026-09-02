import { AppMock } from "@/components/home/AppMock"
import { CallToAction } from "@/components/home/CallToAction"
import { Features } from "@/components/home/Features"
import { Hero } from "@/components/home/Hero"
import { Stack } from "@/components/home/Stack"

export default function HomePage() {
  return (
    <>
      <Hero />
      <AppMock />
      <Stack />
      <Features />
      <CallToAction />
    </>
  )
}
