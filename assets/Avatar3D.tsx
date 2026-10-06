import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

/* ------------------------------- Types ---------------------------------- */

export type AvatarGender = 'female' | 'male';

export interface Avatar3DProps {
    /** 'female' = long curls + V-neck (reference look), 'male' = short crop + broad torso */
    gender?: AvatarGender;
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

/* ------------------------- Curly hair (instanced) ----------------------- */

interface HairCube {
    position: [number, number, number];
    scale: [number, number, number];
    rotation: [number, number, number];
    shade: number;
}

/** Deterministic PRNG so the hairdo never changes between renders */
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Builds the curly hair: gender decides between a long afro and a short crop */
function buildHairCubes(gender: AvatarGender): HairCube[] {
    const female = gender === 'female';
    const rand = mulberry32(female ? 20240613 : 97531042);
    const cubes: HairCube[] = [];

    const add = (x: number, y: number, z: number, base: number) => {
        cubes.push({
            position: [x, y, z],
            scale: [
                base * (0.75 + rand() * 0.55),
                base * (0.75 + rand() * 0.55),
                base * (0.75 + rand() * 0.55),
            ],
            rotation: [(rand() - 0.5) * 0.7, rand() * Math.PI, (rand() - 0.5) * 0.7],
            shade: rand(),
        });
    };

    // 1 — top cap (both genders; the male crop sits tighter and wraps lower)
    for (let i = 0; i < 140; i++) {
        const theta = rand() * Math.PI * 2;
        const phi = Math.acos(1 - rand() * (female ? 0.62 : 0.8));
        const r = (female ? 0.42 : 0.4) + rand() * (female ? 0.16 : 0.1);
        const x = Math.sin(phi) * Math.cos(theta) * r;
        const y = Math.cos(phi) * r + 0.16;
        const z = Math.sin(phi) * Math.sin(theta) * r;
        if (z > (female ? 0.16 : 0.22) && y < (female ? 0.5 : 0.44) && Math.abs(x) < (female ? 0.3 : 0.26)) continue;
        add(x, y, z, female ? 0.2 : 0.16);
    }

    // ——— Male: short sides/back taper + sideburns, then stop ———
    if (!female) {
        for (let i = 0; i < 55; i++) {
            const theta = rand() * Math.PI * 2;
            const phi = Math.PI / 2 + rand() * 0.4; // just below the equator
            const r = 0.45 + rand() * 0.06;
            const x = Math.sin(phi) * Math.cos(theta) * r;
            const y = Math.cos(phi) * r + 0.16;
            const z = Math.sin(phi) * Math.sin(theta) * r;
            if (z > 0.24) continue; // face stays clear
            add(x, y, z, 0.13);
        }
        for (const side of [-1, 1]) {
            for (let k = 0; k < 3; k++) {
                add(side * 0.42, 0.02 - k * 0.09, 0.08, 0.1);
            }
        }
        return cubes;
    }

    // 2 — side curtains (strands falling past the shoulders)
    for (const side of [-1, 1]) {
        for (let s = 0; s < 8; s++) {
            const sx = side * (0.4 + rand() * 0.2);
            const sz = -0.3 + rand() * 0.55;
            const count = 6 + Math.floor(rand() * 4);
            const drift = (rand() - 0.5) * 0.12;
            for (let k = 0; k < count; k++) {
                const t = k / (count - 1);
                add(
                    sx + side * t * 0.1 + drift * t + (rand() - 0.5) * 0.08,
                    0.34 - t * (1.0 + rand() * 0.2),
                    sz + (rand() - 0.5) * 0.1,
                    0.21 - t * 0.05,
                );
            }
        }
    }

    // 3 — back curtain
    for (let s = 0; s < 9; s++) {
        const bx = (rand() - 0.5) * 0.78;
        const bz = -0.4 - rand() * 0.14;
        const count = 5 + Math.floor(rand() * 4);
        for (let k = 0; k < count; k++) {
            const t = k / (count - 1);
            add(bx + (rand() - 0.5) * 0.1, 0.32 - t * 1.1, bz + t * 0.06, 0.2 - t * 0.05);
        }
    }

    // 4 — fringe / bangs over the forehead
    for (let i = 0; i < 12; i++) {
        add((rand() - 0.5) * 0.6, 0.34 + rand() * 0.14, 0.3 + rand() * 0.12, 0.15);
    }

    return cubes;
}

/* -------------------------------- Head ---------------------------------- */

interface HeadProps {
    gender: AvatarGender;
    skinColor: string;
    hairColor: string;
    eyeColor: string;
    followMouse: boolean;
}

const Head: React.FC<HeadProps> = ({ gender, skinColor, hairColor, eyeColor, followMouse }) => {
    const isFemale = gender === 'female';
    const group = useRef<THREE.Group>(null!);
    const eyes = useRef<THREE.Group>(null!);
    const hairRef = useRef<THREE.InstancedMesh>(null!);

    const hair = useMemo(() => buildHairCubes(gender), [gender]);
    const hairGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
    const hairMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.85 }), []);

    // Bake cube transforms + per-cube color variation into the instanced mesh
    useLayoutEffect(() => {
        const mesh = hairRef.current;
        if (!mesh) return;
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const e = new THREE.Euler();
        const p = new THREE.Vector3();
        const sc = new THREE.Vector3();
        const c = new THREE.Color();
        hair.forEach((cube, i) => {
            e.set(cube.rotation[0], cube.rotation[1], cube.rotation[2]);
            q.setFromEuler(e);
            p.set(cube.position[0], cube.position[1], cube.position[2]);
            sc.set(cube.scale[0], cube.scale[1], cube.scale[2]);
            m.compose(p, q, sc);
            mesh.setMatrixAt(i, m);
            c.set(hairColor).offsetHSL(0, (cube.shade - 0.5) * 0.06, (cube.shade - 0.5) * 0.12);
            mesh.setColorAt(i, c);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }, [hair, hairColor]);

    useFrame((state, delta) => {
        // Head follows the pointer
        if (followMouse && group.current) {
            group.current.rotation.y = THREE.MathUtils.damp(
                group.current.rotation.y, state.pointer.x * 0.5, 5, delta
            );
            group.current.rotation.x = THREE.MathUtils.damp(
                group.current.rotation.x, -state.pointer.y * 0.25, 5, delta
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
        <group ref={group} position={[0, 1.88, 0]}>
            {/* FIX: hair base pushed back + flattened on Z so its front surface
                (z ≈ 0.26 / 0.23) stays behind the face plane (z = 0.36).
                Previously it extended to z ≈ 0.41 and poked through the face
                as a big dark circle. */}
            <mesh
                position={[0, 0.04, -0.14]}
                scale={isFemale ? [1.16, 1.04, 0.95] : [1.08, 0.96, 0.88]}
            >
                <sphereGeometry args={[0.42, 24, 24]} />
                <meshStandardMaterial color={hairColor} roughness={0.95} />
            </mesh>

            {/* Blocky head (LEGO-style rounded box) */}
            <RoundedBox args={[0.85, 0.78, 0.72]} radius={0.15} smoothness={6}>
                <meshStandardMaterial color={skinColor} roughness={0.55} />
            </RoundedBox>

            {/* Curly hair — one instanced draw call (remounts when gender changes) */}
            <instancedMesh
                key={gender}
                ref={hairRef}
                args={[hairGeo, hairMat, hair.length]}
                frustumCulled={false}
            />

            {/* Ears */}
            {[-1, 1].map((s) => (
                <mesh key={s} position={[s * 0.43, -0.02, 0.02]} rotation={[0, 0, Math.PI / 2]}>
                    <cylinderGeometry args={[0.08, 0.08, 0.06, 16]} />
                    <meshStandardMaterial color={skinColor} roughness={0.55} />
                </mesh>
            ))}

            {/* Eyebrows — slightly thicker/bushier for male */}
            {[-1, 1].map((s) => (
                <RoundedBox
                    key={s}
                    args={[isFemale ? 0.16 : 0.19, isFemale ? 0.05 : 0.065, 0.05]}
                    radius={0.02}
                    smoothness={3}
                    position={[s * 0.16, 0.22, 0.35]}
                    rotation={[0, 0, s * (isFemale ? 0.1 : 0.06)]}
                >
                    <meshStandardMaterial color={hairColor} roughness={0.8} />
                </RoundedBox>
            ))}

            {/* Eyes (grouped so both blink together) */}
            <group ref={eyes}>
                {[-1, 1].map((s) => (
                    <group key={s} position={[s * 0.16, 0.06, 0.35]}>
                        <mesh scale={[1, 1, 0.6]}>
                            <sphereGeometry args={[0.058, 20, 20]} />
                            <meshStandardMaterial color={eyeColor} roughness={0.25} />
                        </mesh>
                        <mesh position={[0.02, 0.02, 0.035]}>
                            <sphereGeometry args={[0.016, 8, 8]} />
                            <meshStandardMaterial color="#ffffff" roughness={0.2} />
                        </mesh>
                    </group>
                ))}
            </group>

            {/* Wedge nose */}
            <mesh position={[0, -0.02, 0.4]} rotation={[Math.PI / 2, 0, 0]}>
                <coneGeometry args={[0.065, 0.13, 4, 1, false, Math.PI / 4]} />
                <meshStandardMaterial color={skinColor} roughness={0.55} />
            </mesh>

            {/* Open LEGO smile — dark mouth + teeth */}
            <group position={[0, -0.18, 0.35]}>
                <RoundedBox args={[0.3, 0.15, 0.06]} radius={0.025} smoothness={4}>
                    <meshStandardMaterial color="#332015" roughness={0.5} />
                </RoundedBox>
                <RoundedBox
                    args={[0.25, 0.085, 0.06]}
                    radius={0.028}
                    smoothness={4}
                    position={[0, 0.02, 0.012]}
                >
                    <meshStandardMaterial color="#fffdf6" roughness={0.35} />
                </RoundedBox>
            </group>
        </group>
    );
};

/* -------------------------------- Body ---------------------------------- */

interface BodyProps {
    gender: AvatarGender;
    skinColor: string;
    shirtColor: string;
    pantsColor: string;
    shoeColor: string;
}

const Body: React.FC<BodyProps> = ({ gender, skinColor, shirtColor, pantsColor, shoeColor }) => {
    const isFemale = gender === 'female';
    const arms = useRef<Array<THREE.Group | null>>([]);

    // Gentle idle arm swing
    useFrame((state) => {
        const t = state.clock.elapsedTime;
        arms.current.forEach((arm, i) => {
            if (arm) arm.rotation.x = Math.sin(t * 1.6 + i * Math.PI) * 0.1;
        });
    });

    // LEGO trapezoidal torso — female tapers, male is broad & boxy
    const torsoGeo = useMemo(() => {
        const shape = new THREE.Shape();
        if (isFemale) {
            shape.moveTo(-0.3, -0.32);
            shape.lineTo(0.3, -0.32);
            shape.lineTo(0.24, 0.32);
            shape.lineTo(-0.24, 0.32);
        } else {
            shape.moveTo(-0.33, -0.32);
            shape.lineTo(0.33, -0.32);
            shape.lineTo(0.31, 0.32);
            shape.lineTo(-0.31, 0.32);
        }
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.28,
            steps: 1,
            bevelEnabled: true,
            bevelThickness: 0.05,
            bevelSize: 0.05,
            bevelSegments: 4,
        });
        geo.center();
        return geo;
    }, [gender]);

    // V-neck chest triangle (skin showing through the top) — female only
    const chestGeo = useMemo(() => {
        const shape = new THREE.Shape();
        shape.moveTo(-0.15, 0.3);
        shape.lineTo(0.15, 0.3);
        shape.lineTo(0, -0.12);
        shape.closePath();
        return new THREE.ShapeGeometry(shape);
    }, []);

    const armR = isFemale ? 0.088 : 0.102;
    const foreR = isFemale ? 0.08 : 0.095;

    return (
        <group>
            {/* Torso */}
            <mesh geometry={torsoGeo} position={[0, 1.04, 0]}>
                <meshStandardMaterial color={shirtColor} roughness={0.7} />
            </mesh>

            {/* V-neck opening */}
            {isFemale && (
                <mesh geometry={chestGeo} position={[0, 1.02, 0.215]}>
                    <meshStandardMaterial color={skinColor} roughness={0.6} side={THREE.DoubleSide} />
                </mesh>
            )}

            {/* Neck post + collar (male gets a thicker neck) */}
            <mesh position={[0, 1.42, 0]}>
                <cylinderGeometry args={[isFemale ? 0.13 : 0.145, isFemale ? 0.13 : 0.145, 0.22, 24]} />
                <meshStandardMaterial color={shirtColor} roughness={0.7} />
            </mesh>
            <mesh position={[0, 1.46, 0]}>
                <cylinderGeometry args={[isFemale ? 0.205 : 0.225, isFemale ? 0.205 : 0.225, 0.06, 24]} />
                <meshStandardMaterial color={shirtColor} roughness={0.7} />
            </mesh>

            {/* LEGO arms: shoulder cap + upper arm + forward-bent forearm + hand */}
            {[-1, 1].map((s, i) => (
                <group
                    key={s}
                    ref={(el) => { arms.current[i] = el; }}
                    position={[s * (isFemale ? 0.37 : 0.4), 1.3, 0]}
                >
                    <mesh scale={[1, 0.85, 0.9]}>
                        <sphereGeometry args={[isFemale ? 0.14 : 0.15, 20, 20]} />
                        <meshStandardMaterial color={shirtColor} roughness={0.7} />
                    </mesh>
                    <group rotation={[0, 0, s * 0.22]}>
                        <mesh position={[0, -0.21, 0]}>
                            <capsuleGeometry args={[armR, 0.24, 6, 14]} />
                            <meshStandardMaterial color={skinColor} roughness={0.6} />
                        </mesh>
                        <group position={[0, -0.42, 0]} rotation={[-0.5, 0, 0]}>
                            <mesh position={[0, -0.16, 0]}>
                                <capsuleGeometry args={[foreR, 0.18, 6, 14]} />
                                <meshStandardMaterial color={skinColor} roughness={0.6} />
                            </mesh>
                            <mesh position={[0, -0.34, 0]}>
                                <sphereGeometry args={[isFemale ? 0.1 : 0.11, 18, 18]} />
                                <meshStandardMaterial color={skinColor} roughness={0.55} />
                            </mesh>
                        </group>
                    </group>
                </group>
            ))}

            {/* Hip block — slightly wider on female */}
            <mesh position={[0, 0.66, 0]}>
                <boxGeometry args={[isFemale ? 0.52 : 0.5, 0.2, 0.34]} />
                <meshStandardMaterial color={pantsColor} roughness={0.8} />
            </mesh>

            {/* Blocky legs + feet */}
            {[-1, 1].map((s) => (
                <group key={s} position={[s * 0.135, 0, 0]}>
                    <mesh position={[0, 0.38, 0]}>
                        <boxGeometry args={[0.23, 0.42, 0.32]} />
                        <meshStandardMaterial color={pantsColor} roughness={0.8} />
                    </mesh>
                    <mesh position={[0, 0.07, 0.05]}>
                        <boxGeometry args={[0.23, 0.14, 0.44]} />
                        <meshStandardMaterial color={shoeColor} roughness={0.55} />
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
        {/* Warm key light + cool rim, no HDRI needed */}
        <ambientLight intensity={0.7} />
        <directionalLight position={[3, 5, 4]} intensity={1.5} color="#fff1de" />
        <directionalLight position={[-4, 3, -4]} intensity={0.55} color="#cdd9ff" />
        <directionalLight position={[0, 2, 5]} intensity={0.35} />

        {/* Gentle floating idle animation */}
        <Float speed={2} rotationIntensity={0.12} floatIntensity={0.35} floatingRange={[-0.02, 0.05]}>
            <Head
                gender={props.gender}
                skinColor={props.skinColor}
                hairColor={props.hairColor}
                eyeColor={props.eyeColor}
                followMouse={props.followMouse}
            />
            <Body
                gender={props.gender}
                skinColor={props.skinColor}
                shirtColor={props.shirtColor}
                pantsColor={props.pantsColor}
                shoeColor={props.shoeColor}
            />
        </Float>

        {/* Ground ring + soft contact shadow */}
        <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.85, 0.95, 64]} />
            <meshBasicMaterial color="#b9c2cc" transparent opacity={0.35} />
        </mesh>
        <ContactShadows position={[0, 0.001, 0]} opacity={0.42} scale={5} blur={2.4} far={2.4} color="#3b2a1a" />

        <OrbitControls
            makeDefault
            target={[0, 1.38, 0]}
            enablePan={false}
            minDistance={1.6}
            maxDistance={8}
            autoRotate={props.autoRotate}
            autoRotateSpeed={1.2}
        />
    </>
);

/* ---------------------------- Main component ---------------------------- */

export const Avatar3D: React.FC<Avatar3DProps> = ({
    gender = 'female',
    skinColor = '#d99a62',   // warm wood tone
    hairColor = '#4a2a1a',   // dark chocolate curls
    shirtColor = '#f6f2ea',  // white top
    pantsColor = '#ece7dd',
    shoeColor = '#b98a54',
    eyeColor = '#241812',
    followMouse = true,
    autoRotate = false,
    className,
    style,
}) => (
    <div className={className} style={{ width: '100%', height: '100%', minHeight: 340, ...style }}>
        <Canvas
            camera={{ position: [0.45, 1.8, 4.0], fov: 34 }}
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true }}
        >
            <AvatarScene
                gender={gender}
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
