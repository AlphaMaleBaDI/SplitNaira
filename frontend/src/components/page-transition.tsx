"use client";

import { motion, AnimatePresence, type Variants } from "framer-motion";
import { type ReactNode } from "react";

const pageVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.15, ease: "easeIn" } },
};

interface PageTransitionProps {
  children: ReactNode;
  motionKey: string;
}

export function PageTransition({ children, motionKey }: PageTransitionProps) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={motionKey}
        initial="hidden"
        animate="visible"
        exit="exit"
        variants={pageVariants}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
