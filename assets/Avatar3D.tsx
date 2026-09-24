import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

/* ------------------------------- Types ---------------------------------- */

export interface Avatar3DProps {
  skinColor?: string;
  hairColor?: string;
  shirtColor?: string;
  pantsColor?: string;
  shoeColor?: string;
  eyeColor?: string;
  /** Head tracks the pointer */
  followMouse?: boolean;
  /** Camera slowly orbits */
  autoRotate?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/* -------------------------------- Head ---------------------------------- */

interface HeadProps {
  skinColor: string;
  hairColor: string;
  eyeColor: string;
  followMouse: boolean;
}

const Head: React.FC<HeadProps> = ({ skinColor, hairColor, eyeColor, followMouse }) => {
  const group = useRef<THREE.Group>(null!);
  const eyes = useRef<THREE.Group>(null!);

  useFrame((state, delta) => {
    // Head follows the pointer
    if (followMouse && group.current) {
      group.current.rotation.y = THREE.MathUtils.damp(
        group.current.rotation.y, state.pointer.x * 0.55, 5, delta
      );
      group.current.rotation.x = THREE.MathUtils.damp(
        group.current.rotation.x, -state.pointer.y * 0.3, 5, delta
      );
    }

    // Blink every ~4 seconds
    if (eyes.current) {
      const closed = state.clock.elapsedTime % 4 > 3.85;
      eyes.current.scale.y = THREE.MathUtils.damp(
        eyes.current.scale.y, closed ? 0.08 : 1, 30, delta
      );
    }
  });

  return (
    <group ref={group} position={[0, 1.72, 0]}>
      {/* Skull */}
      <mesh>
        <sphereGeometry args={[0.5, 32, 32]} />
        <meshStandardMaterial color={skinColor} roughness={0.65} />
      </mesh>

      {/* Hair (spherical cap, tilted back) */}
      <mesh position={[0, 0.05, -0.02]} rotation={[-0.15, 0, 0]}>
        <sphereGeometry args={[0.53, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.42]} />
        <meshStandardMaterial color={hairColor} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>

      {/* Ears */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.48, -0.02, 0]} scale={[0.45, 0.9, 0.7]}>
          <sphereGeometry args={[0.13, 16, 16]} />
          <meshStandardMaterial color={skinColor} roughness={0.65} />
        </mesh>
      ))}

      {/* Eyes (grouped so both blink together) */}
      <group ref={eyes} position={[0, 0.03, 0]}>
        {[-1, 1].map((s) => (
          <group key={s} position={[s * 0.17, 0, 0.43]}>
            <mesh>
              <sphereGeometry args={[0.085, 16, 16]} />
              <meshStandardMaterial color="#ffffff" roughness={0.25} />
            </mesh>
            <mesh position={[0, 0, 0.055]}>
              <sphereGeometry args={[0.042, 16, 16]} />
              <meshStandardMaterial color={eyeColor} roughness={0.2} />
            </mesh>
          </group>
        ))}
      </group>

      {/* Nose */}
      <mesh position={[0, -0.07, 0.49]}>
        <sphereGeometry args={[0.045, 16, 16]} />
        <meshStandardMaterial color={skinColor} roughness={0.7} />
      </mesh>

      {/* Smile (half torus flipped into a "U") */}
      <mesh position={[0, -0.16, 0.44]} rotation={[0, 0, Math.PI]}>
        <torusGeometry args={[0.13, 0.018, 8, 24, Math.PI]} />
        <meshStandardMaterial color="#7c4a3a" roughness={0.6} />
      </mesh>

      {/* Blush */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.3, -0.13, 0.37]} scale={[1, 0.6, 0.4]}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshStandardMaterial color="#f2998f" roughness={1} />
        </mesh>
      ))}
    </group>
  );
};

/* -------------------------------- Body ---------------------------------- */

interface BodyProps {
  skinColor: string;
  shirtColor: string;
  pantsColor: string;
  shoeColor: string;
}

const Body: React.FC<BodyProps> = ({ skinColor, shirtColor, pantsColor, shoeColor }) => {
  const arms = useRef<Array<THREE.Group | null>>([]);

  // Gentle idle arm swing
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    arms.current.forEach((arm, i) => {
      if (arm) arm.rotation.x = Math.sin(t * 1.6 + i * Math.PI) * 0.08;
    });
  });

  return (
    <group>
      {/* Torso */}
      <mesh position={[0, 0.88, 0]}>
        <capsuleGeometry args={[0.32, 0.5, 8, 24]} />
        <meshStandardMaterial color={shirtColor} roughness={0.75} />
      </mesh>

      {/* Arms + hands */}
      {[-1, 1].map((s, i) => (
        <group
          key={s}
          ref={(el) => { arms.current[i] = el; }}
          position={[s * 0.38, 1.12, 0]}
          rotation={[0, 0, s * 0.45]}
        >
          <mesh position={[0, -0.26, 0]}>
            <capsuleGeometry args={[0.09, 0.34, 4, 12]} />
            <meshStandardMaterial color={shirtColor} roughness={0.75} />
          </mesh>
          <mesh position={[0, -0.52, 0]}>
            <sphereGeometry args={[0.105, 16, 16]} />
            <meshStandardMaterial color={skinColor} roughness={0.65} />
          </mesh>
        </group>
      ))}

      {/* Legs + shoes */}
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.15, 0.5, 0]}>
          <mesh position={[0, -0.2, 0]}>
            <capsuleGeometry args={[0.11, 0.3, 4, 12]} />
            <meshStandardMaterial color={pantsColor} roughness={0.8} />
          </mesh>
          <mesh position={[0, -0.42, 0.05]} scale={[1, 0.6, 1.5]}>
            <sphereGeometry args={[0.11, 16, 16]} />
            <meshStandardMaterial color={shoeColor} roughness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

/* -------------------------------- Scene --------------------------------- */

type SceneProps = Required<Omit<Avatar3DProps, 'className' | 'style'>>;

const AvatarScene: React.FC<SceneProps> = (props) => (
  <>
    {/* Lighting — no HDRI needed, works fully offline */}
    <ambientLight intensity={0.75} />
    <directionalLight position={[3, 5, 4]} intensity={1.6} />
    <directionalLight position={[-4, 3, -4]} intensity={0.5} color="#cdd9ff" />

    {/* Gentle floating idle animation */}
    <Float speed={2.2} rotationIntensity={0.15} floatIntensity={0.45} floatingRange={[-0.02, 0.06]}>
      <Head
        skinColor={props.skinColor}
        hairColor={props.hairColor}
        eyeColor={props.eyeColor}
        followMouse={props.followMouse}
      />
      <Body
        skinColor={props.skinColor}
        shirtColor={props.shirtColor}
        pantsColor={props.pantsColor}
        shoeColor={props.shoeColor}
      />
    </Float>

    {/* Ground ring + soft contact shadow */}
    <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.92, 1.0, 64]} />
      <meshBasicMaterial color="#94a3b8" transparent opacity={0.35} />
    </mesh>
    <ContactShadows position={[0, 0.001, 0]} opacity={0.4} scale={5} blur={2.6} far={2.2} color="#1e293b" />

    <OrbitControls
      makeDefault
      target={[0, 1.0, 0]}
      enablePan={false}
      minDistance={2.4}
      maxDistance={8}
      autoRotate={props.autoRotate}
      autoRotateSpeed={1.2}
    />
  </>
);

/* ---------------------------- Main component ---------------------------- */

export const Avatar3D: React.FC<Avatar3DProps> = ({
  skinColor = '#ffcf9f',
  hairColor = '#2f2118',
  shirtColor = '#5b7cfa',
  pantsColor = '#2d3748',
  shoeColor = '#1a202c',
  eyeColor = '#22223b',
  followMouse = true,
  autoRotate = false,
  className,
  style,
}) => (
  <div className={className} style={{ width: '100%', height: '100%', minHeight: 340, ...style }}>
    <Canvas
      camera={{ position: [0.4, 1.5, 4.4], fov: 38 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <AvatarScene
        skinColor={skinColor}
        hairColor={hairColor}
        shirtColor={shirtColor}
        pantsColor={pantsColor}
        shoeColor={shoeColor}
        eyeColor={eyeColor}
        followMouse={followMouse}
        autoRotate={autoRotate}
      />
    </Canvas>
  </div>
);

export default Avatar3D;
