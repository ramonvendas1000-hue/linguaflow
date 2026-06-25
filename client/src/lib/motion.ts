import { useReducedMotion } from 'framer-motion';

export const spring = {
  snappy: { type: 'spring', stiffness: 500, damping: 30, mass: 1 },
  smooth: { type: 'spring', stiffness: 300, damping: 25, mass: 1 },
  gentle: { type: 'spring', stiffness: 150, damping: 20, mass: 1.2 },
} as const;

export const fadeUp = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: spring.smooth },
  exit:    { opacity: 0, y: -8, transition: spring.snappy },
};

export const fadeIn = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: spring.smooth },
  exit:    { opacity: 0, transition: spring.snappy },
};

export const pop = {
  rest:  { scale: 1 },
  hover: { scale: 1.05, transition: spring.snappy },
  tap:   { scale: 0.95, transition: spring.snappy },
};

export const slideRight = {
  hidden:  { x: '-100%', opacity: 0 },
  visible: { x: 0, opacity: 1, transition: spring.smooth },
  exit:    { x: '-100%', opacity: 0, transition: spring.snappy },
};

export const slideLeft = {
  hidden:  { x: '100%', opacity: 0 },
  visible: { x: 0, opacity: 1, transition: spring.smooth },
  exit:    { x: '100%', opacity: 0, transition: spring.snappy },
};

export const staggerContainer = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
};

export const backdrop = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit:    { opacity: 0, transition: { duration: 0.15 } },
};

export const modal = {
  hidden:  { opacity: 0, scale: 0.95, y: 12 },
  visible: { opacity: 1, scale: 1, y: 0, transition: spring.smooth },
  exit:    { opacity: 0, scale: 0.97, y: 6, transition: spring.snappy },
};

export function useSafeSpring() {
  const reduced = useReducedMotion();
  return reduced ? { type: 'tween', duration: 0 } : spring.smooth;
}
