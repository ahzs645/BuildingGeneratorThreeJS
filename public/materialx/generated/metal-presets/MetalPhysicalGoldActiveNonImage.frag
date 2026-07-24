#version 300 es

precision highp float;
precision highp int;


struct BSDF { vec3 response; vec3 throughput; };
#define EDF vec3
struct surfaceshader { vec3 color; vec3 transparency; };
struct volumeshader { vec3 color; vec3 transparency; };
struct displacementshader { vec3 offset; float scale; };
struct lightshader { vec3 intensity; vec3 direction; };
#define material surfaceshader

// Uniform block: PrivateUniforms
uniform mat4 u_envMatrix;
uniform sampler2D u_envRadiance;
uniform float u_envLightIntensity;
uniform int u_envRadianceMips;
uniform int u_envRadianceSamples;
uniform sampler2D u_envIrradiance;
uniform bool u_refractionTwoSided;
uniform vec3 u_viewPosition;
uniform mat4 u_worldInverseTransposeMatrix;
uniform int u_numActiveLightSources;

// Uniform block: PublicUniforms
uniform surfaceshader backsurfaceshader;
uniform displacementshader displacementshader1;
uniform vec3 generated_extent_in1;
uniform vec3 generated_extent_in2;
uniform int normal_world_fromspace;
uniform int normal_world_tospace;
uniform vec3 generated_offset_in2;
uniform vec3 generated_safe_extent_in2;
uniform vec3 mapping_scale_in2;
uniform float g_squared_in2;
uniform float length_mix_mix;
uniform float noise_position_in2;
uniform float blender_fbm3_gold_brushed_noise_amplitude;
uniform int blender_fbm3_gold_brushed_noise_octaves;
uniform float blender_fbm3_gold_brushed_noise_lacunarity;
uniform float blender_fbm3_gold_brushed_noise_diminish;
uniform float b_denominator_in2;
uniform float b_numerator_in2;
uniform float brushed_gate_unclamped_inlow;
uniform float brushed_gate_unclamped_inhigh;
uniform float brushed_gate_unclamped_outlow;
uniform float brushed_gate_unclamped_outhigh;
uniform float half_a_squared_in1;
uniform float brushed_gate_low;
uniform float brushed_gate_high;
uniform float one_plus_b_squared_in1;
uniform float brushed_add_in1;
uniform float one_minus_brushed_add_in1;
uniform float one_minus_fresnel_in1;
uniform float lut_scaled_factor_in2;
uniform float lut_centered_factor_in2;
uniform float lut_uv_in2;
uniform sampler2D curve_ramp_response_file;
uniform int curve_ramp_response_layer;
uniform float curve_ramp_response_default;
uniform int curve_ramp_response_uaddressmode;
uniform int curve_ramp_response_vaddressmode;
uniform int curve_ramp_response_filtertype;
uniform int curve_ramp_response_framerange;
uniform int curve_ramp_response_frameoffset;
uniform int curve_ramp_response_frameendaction;
uniform vec2 curve_ramp_response_uv_scale;
uniform vec2 curve_ramp_response_uv_offset;
uniform float authored_base_roughness_in1;
uniform float one_minus_base_roughness_in1;
uniform float perceptual_roughness_in1;
uniform float active_perceptual_roughness_in2;
uniform float roughness_025_in2;
uniform float roughness_050_in2;
uniform float roughness_075_in2;
uniform float roughness_100_conductor_weight;
uniform vec3 roughness_100_conductor_ior;
uniform vec3 roughness_100_conductor_extinction;
uniform float roughness_100_conductor_thinfilm_thickness;
uniform float roughness_100_conductor_thinfilm_ior;
uniform int roughness_100_conductor_distribution;
uniform float roughness_025_conductor_weight;
uniform vec3 roughness_025_conductor_ior;
uniform vec3 roughness_025_conductor_extinction;
uniform float roughness_025_conductor_thinfilm_thickness;
uniform float roughness_025_conductor_thinfilm_ior;
uniform int roughness_025_conductor_distribution;
uniform float roughness_050_conductor_weight;
uniform vec3 roughness_050_conductor_ior;
uniform vec3 roughness_050_conductor_extinction;
uniform float roughness_050_conductor_thinfilm_thickness;
uniform float roughness_050_conductor_thinfilm_ior;
uniform int roughness_050_conductor_distribution;
uniform float roughness_075_conductor_weight;
uniform vec3 roughness_075_conductor_ior;
uniform vec3 roughness_075_conductor_extinction;
uniform float roughness_075_conductor_thinfilm_thickness;
uniform float roughness_075_conductor_thinfilm_ior;
uniform int roughness_075_conductor_distribution;
uniform float mix_025_050_mix;
uniform float mix_050_075_mix;
uniform float mix_075_100_mix;
uniform float surface_physical_gold_active_non_image_opacity;
uniform bool surface_physical_gold_active_non_image_thin_walled;

in vec3 normalWorld;
in vec3 tangentWorld;
in vec3 normalObject;
in vec3 positionWorld;
in vec3 positionObject;

// Pixel shader outputs
out vec4 out1;

#define M_FLOAT_EPS 1e-8

#define mx_mod mod
#define mx_inverse inverse
#define mx_inversesqrt inversesqrt
#define mx_sin sin
#define mx_cos cos
#define mx_tan tan
#define mx_asin asin
#define mx_acos acos
#define mx_atan atan
#define mx_radians radians

float mx_square(float x)
{
    return x*x;
}

vec2 mx_square(vec2 x)
{
    return x*x;
}

vec3 mx_square(vec3 x)
{
    return x*x;
}

vec3 mx_srgb_encode(vec3 color)
{
    bvec3 isAbove = greaterThan(color, vec3(0.0031308));
    vec3 linSeg = color * 12.92;
    vec3 powSeg = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(linSeg, powSeg, isAbove);
}

#define DIRECTIONAL_ALBEDO_METHOD 0

#define MAX_LIGHT_SOURCES 3
#define M_PI 3.1415926535897932
#define M_PI_INV (1.0 / M_PI)

float mx_pow5(float x)
{
    return mx_square(mx_square(x)) * x;
}

float mx_pow6(float x)
{
    float x2 = mx_square(x);
    return mx_square(x2) * x2;
}

// Standard Schlick Fresnel
float mx_fresnel_schlick(float cosTheta, float F0)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    float x5 = mx_pow5(x);
    return F0 + (1.0 - F0) * x5;
}
vec3 mx_fresnel_schlick(float cosTheta, vec3 F0)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    float x5 = mx_pow5(x);
    return F0 + (1.0 - F0) * x5;
}

// Generalized Schlick Fresnel
float mx_fresnel_schlick(float cosTheta, float F0, float F90)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    float x5 = mx_pow5(x);
    return mix(F0, F90, x5);
}
vec3 mx_fresnel_schlick(float cosTheta, vec3 F0, vec3 F90)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    float x5 = mx_pow5(x);
    return mix(F0, F90, x5);
}

// Generalized Schlick Fresnel with a variable exponent
float mx_fresnel_schlick(float cosTheta, float F0, float F90, float exponent)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    return mix(F0, F90, pow(x, exponent));
}
vec3 mx_fresnel_schlick(float cosTheta, vec3 F0, vec3 F90, float exponent)
{
    float x = clamp(1.0 - cosTheta, 0.0, 1.0);
    return mix(F0, F90, pow(x, exponent));
}

// Enforce that the given normal is forward-facing from the specified view direction.
vec3 mx_forward_facing_normal(vec3 N, vec3 V)
{
    return (dot(N, V) < 0.0) ? -N : N;
}

// https://www.graphics.rwth-aachen.de/publication/2/jgt.pdf
float mx_golden_ratio_sequence(int i)
{
    const float GOLDEN_RATIO = 1.6180339887498948;
    return fract((float(i) + 1.0) * GOLDEN_RATIO);
}

// https://people.irisa.fr/Ricardo.Marques/articles/2013/SF_CGF.pdf
vec2 mx_spherical_fibonacci(int i, int numSamples)
{
    return vec2((float(i) + 0.5) / float(numSamples), mx_golden_ratio_sequence(i));
}

// Generate a uniform-weighted sample on the unit hemisphere.
vec3 mx_uniform_sample_hemisphere(vec2 Xi)
{
    float phi = 2.0 * M_PI * Xi.x;
    float cosTheta = 1.0 - Xi.y;
    float sinTheta = sqrt(1.0 - mx_square(cosTheta));
    return vec3(mx_cos(phi) * sinTheta,
                mx_sin(phi) * sinTheta,
                cosTheta);
}

// Generate a cosine-weighted sample on the unit hemisphere.
vec3 mx_cosine_sample_hemisphere(vec2 Xi)
{
    float phi = 2.0 * M_PI * Xi.x;
    float cosTheta = sqrt(Xi.y);
    float sinTheta = sqrt(1.0 - Xi.y);
    return vec3(mx_cos(phi) * sinTheta,
                mx_sin(phi) * sinTheta,
                cosTheta);
}

// Construct an orthonormal basis from a unit vector.
// https://graphics.pixar.com/library/OrthonormalB/paper.pdf
mat3 mx_orthonormal_basis(vec3 N)
{
    float sign = (N.z < 0.0) ? -1.0 : 1.0;
    float a = -1.0 / (sign + N.z);
    float b = N.x * N.y * a;
    vec3 X = vec3(1.0 + sign * N.x * N.x * a, sign * b, -sign * N.x);
    vec3 Y = vec3(b, sign + N.y * N.y * a, -N.y);
    return mat3(X, Y, N);
}

const int FRESNEL_MODEL_DIELECTRIC = 0;
const int FRESNEL_MODEL_CONDUCTOR = 1;
const int FRESNEL_MODEL_SCHLICK = 2;

// Parameters for Fresnel calculations
struct FresnelData
{
    // Fresnel model
    int model;
    bool airy;

    // Physical Fresnel
    vec3 ior;
    vec3 extinction;

    // Generalized Schlick Fresnel
    vec3 F0;
    vec3 F82;
    vec3 F90;
    float exponent;

    // Thin film
    float tf_thickness;
    float tf_ior;

    // Refraction
    bool refraction;
};

// https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf
// Appendix B.2 Equation 13
float mx_ggx_NDF(vec3 H, vec2 alpha)
{
    vec2 He = H.xy / alpha;
    float denom = dot(He, He) + mx_square(H.z);
    return 1.0 / (M_PI * alpha.x * alpha.y * mx_square(denom));
}

// https://ggx-research.github.io/publication/2023/06/09/publication-ggx.html
vec3 mx_ggx_importance_sample_VNDF(vec2 Xi, vec3 V, vec2 alpha)
{
    // Transform the view direction to the hemisphere configuration.
    V = normalize(vec3(V.xy * alpha, V.z));

    // Sample a spherical cap in (-V.z, 1].
    float phi = 2.0 * M_PI * Xi.x;
    float z = (1.0 - Xi.y) * (1.0 + V.z) - V.z;
    float sinTheta = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
    float x = sinTheta * mx_cos(phi);
    float y = sinTheta * mx_sin(phi);
    vec3 c = vec3(x, y, z);

    // Compute the microfacet normal.
    vec3 H = c + V;

    // Transform the microfacet normal back to the ellipsoid configuration.
    H = normalize(vec3(H.xy * alpha, max(H.z, 0.0)));

    return H;
}

// https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf
// Equation 34
float mx_ggx_smith_G1(float cosTheta, float alpha)
{
    float cosTheta2 = mx_square(cosTheta);
    float tanTheta2 = (1.0 - cosTheta2) / cosTheta2;
    return 2.0 / (1.0 + sqrt(1.0 + mx_square(alpha) * tanTheta2));
}

// Height-correlated Smith masking-shadowing
// http://jcgt.org/published/0003/02/03/paper.pdf
// Equations 72 and 99
float mx_ggx_smith_G2(float NdotL, float NdotV, float alpha)
{
    float alpha2 = mx_square(alpha);
    float lambdaL = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotL));
    float lambdaV = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotV));
    return 2.0 * NdotL * NdotV / (lambdaL * NdotV + lambdaV * NdotL);
}

// Rational quadratic fit to Monte Carlo data for GGX directional albedo.
vec3 mx_ggx_dir_albedo_analytic(float NdotV, float alpha, vec3 F0, vec3 F90)
{
    float x = NdotV;
    float y = alpha;
    float x2 = mx_square(x);
    float y2 = mx_square(y);
    vec4 r = vec4(0.1003, 0.9345, 1.0, 1.0) +
             vec4(-0.6303, -2.323, -1.765, 0.2281) * x +
             vec4(9.748, 2.229, 8.263, 15.94) * y +
             vec4(-2.038, -3.748, 11.53, -55.83) * x * y +
             vec4(29.34, 1.424, 28.96, 13.08) * x2 +
             vec4(-8.245, -0.7684, -7.507, 41.26) * y2 +
             vec4(-26.44, 1.436, -36.11, 54.9) * x2 * y +
             vec4(19.99, 0.2913, 15.86, 300.2) * x * y2 +
             vec4(-5.448, 0.6286, 33.37, -285.1) * x2 * y2;
    vec2 AB = clamp(r.xy / r.zw, 0.0, 1.0);
    return F0 * AB.x + F90 * AB.y;
}

vec3 mx_ggx_dir_albedo_table_lookup(float NdotV, float alpha, vec3 F0, vec3 F90)
{
#if DIRECTIONAL_ALBEDO_METHOD == 1
    if (textureSize(u_albedoTable, 0).x > 1)
    {
        vec2 AB = texture(u_albedoTable, vec2(NdotV, alpha)).rg;
        return F0 * AB.x + F90 * AB.y;
    }
#endif
    return vec3(0.0);
}

// https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf
vec3 mx_ggx_dir_albedo_monte_carlo(float NdotV, float alpha, vec3 F0, vec3 F90)
{
    NdotV = clamp(NdotV, M_FLOAT_EPS, 1.0);
    vec3 V = vec3(sqrt(1.0 - mx_square(NdotV)), 0, NdotV);

    vec2 AB = vec2(0.0);
    const int SAMPLE_COUNT = 64;
    for (int i = 0; i < SAMPLE_COUNT; i++)
    {
        vec2 Xi = mx_spherical_fibonacci(i, SAMPLE_COUNT);

        // Compute the half vector and incoming light direction.
        vec3 H = mx_ggx_importance_sample_VNDF(Xi, V, vec2(alpha));
        vec3 L = -reflect(V, H);

        // Compute dot products for this sample.
        float NdotL = clamp(L.z, M_FLOAT_EPS, 1.0);
        float VdotH = clamp(dot(V, H), M_FLOAT_EPS, 1.0);

        // Compute the Fresnel term.
        float Fc = mx_fresnel_schlick(VdotH, 0.0, 1.0);

        // Compute the per-sample geometric term.
        // https://hal.inria.fr/hal-00996995v2/document, Algorithm 2
        float G2 = mx_ggx_smith_G2(NdotL, NdotV, alpha);

        // Add the contribution of this sample.
        AB += vec2(G2 * (1.0 - Fc), G2 * Fc);
    }

    // Apply the global component of the geometric term and normalize.
    AB /= mx_ggx_smith_G1(NdotV, alpha) * float(SAMPLE_COUNT);

    // Return the final directional albedo.
    return F0 * AB.x + F90 * AB.y;
}

vec3 mx_ggx_dir_albedo(float NdotV, float alpha, vec3 F0, vec3 F90)
{
#if DIRECTIONAL_ALBEDO_METHOD == 0
    return mx_ggx_dir_albedo_analytic(NdotV, alpha, F0, F90);
#elif DIRECTIONAL_ALBEDO_METHOD == 1
    return mx_ggx_dir_albedo_table_lookup(NdotV, alpha, F0, F90);
#else
    return mx_ggx_dir_albedo_monte_carlo(NdotV, alpha, F0, F90);
#endif
}

float mx_ggx_dir_albedo(float NdotV, float alpha, float F0, float F90)
{
    return mx_ggx_dir_albedo(NdotV, alpha, vec3(F0), vec3(F90)).x;
}

// https://blog.selfshadow.com/publications/turquin/ms_comp_final.pdf
// Equations 14 and 16
vec3 mx_ggx_energy_compensation(float NdotV, float alpha, vec3 Fss)
{
    float Ess = mx_ggx_dir_albedo(NdotV, alpha, 1.0, 1.0);
    return 1.0 + Fss * (1.0 - Ess) / Ess;
}

float mx_ggx_energy_compensation(float NdotV, float alpha, float Fss)
{
    return mx_ggx_energy_compensation(NdotV, alpha, vec3(Fss)).x;
}

// Compute the average of an anisotropic alpha pair.
float mx_average_alpha(vec2 alpha)
{
    return sqrt(alpha.x * alpha.y);
}

// Convert a real-valued index of refraction to normal-incidence reflectivity.
float mx_ior_to_f0(float ior)
{
    return mx_square((ior - 1.0) / (ior + 1.0));
}

// Convert normal-incidence reflectivity to real-valued index of refraction.
float mx_f0_to_ior(float F0)
{
    float sqrtF0 = sqrt(clamp(F0, 0.01, 0.99));
    return (1.0 + sqrtF0) / (1.0 - sqrtF0);
}
vec3 mx_f0_to_ior(vec3 F0)
{
    vec3 sqrtF0 = sqrt(clamp(F0, 0.01, 0.99));
    return (vec3(1.0) + sqrtF0) / (vec3(1.0) - sqrtF0);
}

// https://renderwonk.com/publications/wp-generalization-adobe/gen-adobe.pdf
vec3 mx_fresnel_hoffman_schlick(float cosTheta, FresnelData fd)
{
    const float COS_THETA_MAX = 1.0 / 7.0;
    const float COS_THETA_FACTOR = 1.0 / (COS_THETA_MAX * pow(1.0 - COS_THETA_MAX, 6.0));

    float x = clamp(cosTheta, 0.0, 1.0);
    vec3 a = mix(fd.F0, fd.F90, pow(1.0 - COS_THETA_MAX, fd.exponent)) * (vec3(1.0) - fd.F82) * COS_THETA_FACTOR;
    return mix(fd.F0, fd.F90, pow(1.0 - x, fd.exponent)) - a * x * mx_pow6(1.0 - x);
}

// https://seblagarde.wordpress.com/2013/04/29/memo-on-fresnel-equations/
float mx_fresnel_dielectric(float cosTheta, float ior)
{
    float c = cosTheta;
    float g2 = ior*ior + c*c - 1.0;
    if (g2 < 0.0)
    {
        // Total internal reflection
        return 1.0;
    }

    float g = sqrt(g2);
    return 0.5 * mx_square((g - c) / (g + c)) *
                (1.0 + mx_square(((g + c) * c - 1.0) / ((g - c) * c + 1.0)));
}

// https://seblagarde.wordpress.com/2013/04/29/memo-on-fresnel-equations/
vec2 mx_fresnel_dielectric_polarized(float cosTheta, float ior)
{
    float cosTheta2 = mx_square(clamp(cosTheta, 0.0, 1.0));
    float sinTheta2 = 1.0 - cosTheta2;

    float t0 = max(ior * ior - sinTheta2, 0.0);
    float t1 = t0 + cosTheta2;
    float t2 = 2.0 * sqrt(t0) * cosTheta;
    float Rs = (t1 - t2) / (t1 + t2);

    float t3 = cosTheta2 * t0 + sinTheta2 * sinTheta2;
    float t4 = t2 * sinTheta2;
    float Rp = Rs * (t3 - t4) / (t3 + t4);

    return vec2(Rp, Rs);
}

// https://seblagarde.wordpress.com/2013/04/29/memo-on-fresnel-equations/
void mx_fresnel_conductor_polarized(float cosTheta, vec3 n, vec3 k, out vec3 Rp, out vec3 Rs)
{
    float cosTheta2 = mx_square(clamp(cosTheta, 0.0, 1.0));
    float sinTheta2 = 1.0 - cosTheta2;
    vec3 n2 = n * n;
    vec3 k2 = k * k;

    vec3 t0 = n2 - k2 - vec3(sinTheta2);
    vec3 a2plusb2 = sqrt(t0 * t0 + 4.0 * n2 * k2);
    vec3 t1 = a2plusb2 + vec3(cosTheta2);
    vec3 a = sqrt(max(0.5 * (a2plusb2 + t0), 0.0));
    vec3 t2 = 2.0 * a * cosTheta;
    Rs = (t1 - t2) / (t1 + t2);

    vec3 t3 = cosTheta2 * a2plusb2 + vec3(sinTheta2 * sinTheta2);
    vec3 t4 = t2 * sinTheta2;
    Rp = Rs * (t3 - t4) / (t3 + t4);
}

vec3 mx_fresnel_conductor(float cosTheta, vec3 n, vec3 k)
{
    vec3 Rp, Rs;
    mx_fresnel_conductor_polarized(cosTheta, n, k, Rp, Rs);
    return 0.5 * (Rp  + Rs);
}

// https://belcour.github.io/blog/research/publication/2017/05/01/brdf-thin-film.html
void mx_fresnel_conductor_phase_polarized(float cosTheta, float eta1, vec3 eta2, vec3 kappa2, out vec3 phiP, out vec3 phiS)
{
    vec3 k2 = kappa2 / eta2;
    vec3 sinThetaSqr = vec3(1.0) - cosTheta * cosTheta;
    vec3 A = eta2*eta2*(vec3(1.0)-k2*k2) - eta1*eta1*sinThetaSqr;
    vec3 B = sqrt(A*A + mx_square(2.0*eta2*eta2*k2));
    vec3 U = sqrt((A+B)/2.0);
    vec3 V = max(vec3(0.0), sqrt((B-A)/2.0));

    phiS = mx_atan(2.0*eta1*V*cosTheta, U*U + V*V - mx_square(eta1*cosTheta));
    phiP = mx_atan(2.0*eta1*eta2*eta2*cosTheta * (2.0*k2*U - (vec3(1.0)-k2*k2) * V),
                   mx_square(eta2*eta2*(vec3(1.0)+k2*k2)*cosTheta) - eta1*eta1*(U*U+V*V));
}

// https://belcour.github.io/blog/research/publication/2017/05/01/brdf-thin-film.html
vec3 mx_eval_sensitivity(float opd, vec3 shift)
{
    // Use Gaussian fits, given by 3 parameters: val, pos and var
    float phase = 2.0*M_PI * opd;
    vec3 val = vec3(5.4856e-13, 4.4201e-13, 5.2481e-13);
    vec3 pos = vec3(1.6810e+06, 1.7953e+06, 2.2084e+06);
    vec3 var = vec3(4.3278e+09, 9.3046e+09, 6.6121e+09);
    vec3 xyz = val * sqrt(2.0*M_PI * var) * mx_cos(pos * phase + shift) * exp(- var * phase*phase);
    xyz.x   += 9.7470e-14 * sqrt(2.0*M_PI * 4.5282e+09) * mx_cos(2.2399e+06 * phase + shift[0]) * exp(- 4.5282e+09 * phase*phase);
    return xyz / 1.0685e-7;
}

// A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence
// https://belcour.github.io/blog/research/publication/2017/05/01/brdf-thin-film.html
vec3 mx_fresnel_airy(float cosTheta, FresnelData fd)
{
    // XYZ to CIE 1931 RGB color space (using neutral E illuminant)
    const mat3 XYZ_TO_RGB = mat3(2.3706743, -0.5138850, 0.0052982, -0.9000405, 1.4253036, -0.0146949, -0.4706338, 0.0885814, 1.0093968);

    // Assume vacuum on the outside
    float eta1 = 1.0;
    float eta2 = max(fd.tf_ior, eta1);
    vec3 eta3 = (fd.model == FRESNEL_MODEL_SCHLICK) ? mx_f0_to_ior(fd.F0) : fd.ior;
    vec3 kappa3 = (fd.model == FRESNEL_MODEL_SCHLICK) ? vec3(0.0) : fd.extinction;
    float cosThetaT = sqrt(1.0 - (1.0 - mx_square(cosTheta)) * mx_square(eta1 / eta2));

    // First interface
    vec2 R12 = mx_fresnel_dielectric_polarized(cosTheta, eta2 / eta1);
    if (cosThetaT <= 0.0)
    {
        // Total internal reflection
        R12 = vec2(1.0);
    }
    vec2 T121 = vec2(1.0) - R12;

    // Second interface
    vec3 R23p, R23s;
    if (fd.model == FRESNEL_MODEL_SCHLICK)
    {
        vec3 f = mx_fresnel_hoffman_schlick(cosThetaT, fd);
        R23p = 0.5 * f;
        R23s = 0.5 * f;
    }
    else
    {
        mx_fresnel_conductor_polarized(cosThetaT, eta3 / eta2, kappa3 / eta2, R23p, R23s);
    }

    // Phase shift
    float cosB = mx_cos(mx_atan(eta2 / eta1));
    vec2 phi21 = vec2(cosTheta < cosB ? 0.0 : M_PI, M_PI);
    vec3 phi23p, phi23s;
    if (fd.model == FRESNEL_MODEL_SCHLICK)
    {
        phi23p = vec3((eta3[0] < eta2) ? M_PI : 0.0,
                      (eta3[1] < eta2) ? M_PI : 0.0,
                      (eta3[2] < eta2) ? M_PI : 0.0);
        phi23s = phi23p;
    }
    else
    {
        mx_fresnel_conductor_phase_polarized(cosThetaT, eta2, eta3, kappa3, phi23p, phi23s);
    }
    vec3 r123p = max(sqrt(R12.x*R23p), 0.0);
    vec3 r123s = max(sqrt(R12.y*R23s), 0.0);

    // Iridescence term
    vec3 I = vec3(0.0);
    vec3 Cm, Sm;

    // Optical path difference
    float distMeters = fd.tf_thickness * 1.0e-9;
    float opd = 2.0 * eta2 * cosThetaT * distMeters;

    // Iridescence term using spectral antialiasing for Parallel polarization

    // Reflectance term for m=0 (DC term amplitude)
    vec3 Rs = (mx_square(T121.x) * R23p) / (vec3(1.0) - R12.x*R23p);
    I += R12.x + Rs;

    // Reflectance term for m>0 (pairs of diracs)
    Cm = Rs - T121.x;
    for (int m=1; m<=2; m++)
    {
        Cm *= r123p;
        Sm  = 2.0 * mx_eval_sensitivity(float(m) * opd, float(m)*(phi23p+vec3(phi21.x)));
        I  += Cm*Sm;
    }

    // Iridescence term using spectral antialiasing for Perpendicular polarization

    // Reflectance term for m=0 (DC term amplitude)
    vec3 Rp = (mx_square(T121.y) * R23s) / (vec3(1.0) - R12.y*R23s);
    I += R12.y + Rp;

    // Reflectance term for m>0 (pairs of diracs)
    Cm = Rp - T121.y;
    for (int m=1; m<=2; m++)
    {
        Cm *= r123s;
        Sm  = 2.0 * mx_eval_sensitivity(float(m) * opd, float(m)*(phi23s+vec3(phi21.y)));
        I  += Cm*Sm;
    }

    // Average parallel and perpendicular polarization
    I *= 0.5;

    // Convert back to RGB reflectance
    I = clamp(XYZ_TO_RGB * I, 0.0, 1.0);

    return I;
}

FresnelData mx_init_fresnel_dielectric(float ior, float tf_thickness, float tf_ior)
{
    FresnelData fd;
    fd.model = FRESNEL_MODEL_DIELECTRIC;
    fd.airy = tf_thickness > 0.0;
    fd.ior = vec3(ior);
    fd.extinction = vec3(0.0);
    fd.F0 = vec3(0.0);
    fd.F82 = vec3(0.0);
    fd.F90 = vec3(0.0);
    fd.exponent = 0.0;
    fd.tf_thickness = tf_thickness;
    fd.tf_ior = tf_ior;
    fd.refraction = false;
    return fd;
}

FresnelData mx_init_fresnel_conductor(vec3 ior, vec3 extinction, float tf_thickness, float tf_ior)
{
    FresnelData fd;
    fd.model = FRESNEL_MODEL_CONDUCTOR;
    fd.airy = tf_thickness > 0.0;
    fd.ior = ior;
    fd.extinction = extinction;
    fd.F0 = vec3(0.0);
    fd.F82 = vec3(0.0);
    fd.F90 = vec3(0.0);
    fd.exponent = 0.0;
    fd.tf_thickness = tf_thickness;
    fd.tf_ior = tf_ior;
    fd.refraction = false;
    return fd;
}

FresnelData mx_init_fresnel_schlick(vec3 F0, vec3 F82, vec3 F90, float exponent, float tf_thickness, float tf_ior)
{
    FresnelData fd;
    fd.model = FRESNEL_MODEL_SCHLICK;
    fd.airy = tf_thickness > 0.0;
    fd.ior = vec3(0.0);
    fd.extinction = vec3(0.0);
    fd.F0 = F0;
    fd.F82 = F82;
    fd.F90 = F90;
    fd.exponent = exponent;
    fd.tf_thickness = tf_thickness;
    fd.tf_ior = tf_ior;
    fd.refraction = false;
    return fd;
}

vec3 mx_compute_fresnel(float cosTheta, FresnelData fd)
{
    if (fd.airy)
    {
         return mx_fresnel_airy(cosTheta, fd);
    }
    else if (fd.model == FRESNEL_MODEL_DIELECTRIC)
    {
        return vec3(mx_fresnel_dielectric(cosTheta, fd.ior.x));
    }
    else if (fd.model == FRESNEL_MODEL_CONDUCTOR)
    {
        return mx_fresnel_conductor(cosTheta, fd.ior, fd.extinction);
    }
    else
    {
        return mx_fresnel_hoffman_schlick(cosTheta, fd);
    }
}

// Compute the refraction of a ray through a solid sphere.
vec3 mx_refraction_solid_sphere(vec3 R, vec3 N, float ior)
{
    R = refract(R, N, 1.0 / ior);
    vec3 N1 = normalize(R * dot(R, N) - N * 0.5);
    return refract(R, N1, ior);
}

vec2 mx_latlong_projection(vec3 dir)
{
    float latitude = -mx_asin(dir.y) * M_PI_INV + 0.5;
    float longitude = mx_atan(dir.x, -dir.z) * M_PI_INV * 0.5 + 0.5;
    return vec2(longitude, latitude);
}

vec3 mx_latlong_map_lookup(vec3 dir, mat4 transform, float lod, sampler2D tex_sampler)
{
    vec3 envDir = normalize((transform * vec4(dir,0.0)).xyz);
    vec2 uv = mx_latlong_projection(envDir);
    return textureLod(tex_sampler, uv, lod).rgb;
}

// Return the mip level with the appropriate coverage for a filtered importance sample.
// https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch20.html
// Section 20.4 Equation 13
float mx_latlong_compute_lod(vec3 dir, float pdf, float maxMipLevel, int envSamples)
{
    const float MIP_LEVEL_OFFSET = 1.5;
    float effectiveMaxMipLevel = maxMipLevel - MIP_LEVEL_OFFSET;
    float distortion = sqrt(1.0 - mx_square(dir.y));
    return max(effectiveMaxMipLevel - 0.5 * log2(float(envSamples) * pdf * distortion), 0.0);
}

// Return the mip level associated with the given alpha in a prefiltered environment.
float mx_latlong_alpha_to_lod(float alpha)
{
    float lodBias = (alpha < 0.25) ? sqrt(alpha) : 0.5 * alpha + 0.375;
    return lodBias * float(u_envRadianceMips - 1);
}

vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)
{
    N = mx_forward_facing_normal(N, V);
    vec3 L = fd.refraction ? mx_refraction_solid_sphere(-V, N, fd.ior.x) : -reflect(V, N);

    float NdotV = clamp(dot(N, V), M_FLOAT_EPS, 1.0);

    float avgAlpha = mx_average_alpha(alpha);
    vec3 F = mx_compute_fresnel(NdotV, fd);
    float G = mx_ggx_smith_G2(NdotV, NdotV, avgAlpha);
    vec3 FG = fd.refraction ? vec3(1.0) - (F * G) : F * G;

    vec3 Li = mx_latlong_map_lookup(L, u_envMatrix, mx_latlong_alpha_to_lod(avgAlpha), u_envRadiance);
    return Li * FG * u_envLightIntensity;
}

vec3 mx_environment_irradiance(vec3 N)
{
    vec3 Li = mx_latlong_map_lookup(N, u_envMatrix, 0.0, u_envIrradiance);
    return Li * u_envLightIntensity;
}


vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint)
{
    // Approximate the appearance of surface transmission as glossy
    // environment map refraction, ignoring any scene geometry that might
    // be visible through the surface.
    fd.refraction = true;
    if (u_refractionTwoSided)
    {
        tint = mx_square(tint);
    }
    return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;
}

struct LightData
{
    int type;
    vec3 direction;
    vec3 color;
    float intensity;
};

uniform LightData u_lightData[MAX_LIGHT_SOURCES];

void mx_directional_light(LightData light, vec3 position, out lightshader result)
{
    result.direction = -light.direction;
    result.intensity = light.color * light.intensity;
}

int numActiveLightSources()
{
    return min(u_numActiveLightSources, MAX_LIGHT_SOURCES) ;
}

void sampleLightSource(LightData light, vec3 position, out lightshader result)
{
    result.intensity = vec3(0.0);
    result.direction = vec3(0.0);
    if (light.type == 1)
    {
        mx_directional_light(light, position, result);
    }
}

void NG_convert_float_vector3(float in1, out vec3 out1)
{
    vec3 combine_out = vec3(in1,in1,in1);
    out1 = combine_out;
}

/*
Noise Library.

This library is a modified version of the noise library found in
Open Shading Language:
github.com/imageworks/OpenShadingLanguage/blob/master/src/include/OSL/oslnoise.h

It contains the subset of noise types needed to implement the MaterialX
standard library. The modifications are mainly conversions from C++ to GLSL.
Produced results should be identical to the OSL noise functions.

Original copyright notice:
------------------------------------------------------------------------
Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al.
All Rights Reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of Sony Pictures Imageworks nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
------------------------------------------------------------------------
*/

float mx_select(bool b, float t, float f)
{
    return b ? t : f;
}

float mx_negate_if(float val, bool b)
{
    return b ? -val : val;
}

int mx_floor(float x)
{
    return int(floor(x));
}

// return mx_floor as well as the fractional remainder
float mx_floorfrac(float x, out int i)
{
    i = mx_floor(x);
    return x - float(i);
}

float mx_bilerp(float v0, float v1, float v2, float v3, float s, float t)
{
    float s1 = 1.0 - s;
    return (1.0 - t) * (v0*s1 + v1*s) + t * (v2*s1 + v3*s);
}
vec3 mx_bilerp(vec3 v0, vec3 v1, vec3 v2, vec3 v3, float s, float t)
{
    float s1 = 1.0 - s;
    return (1.0 - t) * (v0*s1 + v1*s) + t * (v2*s1 + v3*s);
}
float mx_trilerp(float v0, float v1, float v2, float v3, float v4, float v5, float v6, float v7, float s, float t, float r)
{
    float s1 = 1.0 - s;
    float t1 = 1.0 - t;
    float r1 = 1.0 - r;
    return (r1*(t1*(v0*s1 + v1*s) + t*(v2*s1 + v3*s)) +
            r*(t1*(v4*s1 + v5*s) + t*(v6*s1 + v7*s)));
}
vec3 mx_trilerp(vec3 v0, vec3 v1, vec3 v2, vec3 v3, vec3 v4, vec3 v5, vec3 v6, vec3 v7, float s, float t, float r)
{
    float s1 = 1.0 - s;
    float t1 = 1.0 - t;
    float r1 = 1.0 - r;
    return (r1*(t1*(v0*s1 + v1*s) + t*(v2*s1 + v3*s)) +
            r*(t1*(v4*s1 + v5*s) + t*(v6*s1 + v7*s)));
}

// 2 and 3 dimensional gradient functions - perform a dot product against a
// randomly chosen vector. Note that the gradient vector is not normalized, but
// this only affects the overall "scale" of the result, so we simply account for
// the scale by multiplying in the corresponding "perlin" function.
float mx_gradient_float(uint hash, float x, float y)
{
    // 8 possible directions (+-1,+-2) and (+-2,+-1)
    uint h = hash & 7u;
    float u = mx_select(h<4u, x, y);
    float v = 2.0 * mx_select(h<4u, y, x);
    // compute the dot product with (x,y).
    return mx_negate_if(u, bool(h&1u)) + mx_negate_if(v, bool(h&2u));
}
float mx_gradient_float(uint hash, float x, float y, float z)
{
    // use vectors pointing to the edges of the cube
    uint h = hash & 15u;
    float u = mx_select(h<8u, x, y);
    float v = mx_select(h<4u, y, mx_select((h==12u)||(h==14u), x, z));
    return mx_negate_if(u, bool(h&1u)) + mx_negate_if(v, bool(h&2u));
}
vec3 mx_gradient_vec3(uvec3 hash, float x, float y)
{
    return vec3(mx_gradient_float(hash.x, x, y), mx_gradient_float(hash.y, x, y), mx_gradient_float(hash.z, x, y));
}
vec3 mx_gradient_vec3(uvec3 hash, float x, float y, float z)
{
    return vec3(mx_gradient_float(hash.x, x, y, z), mx_gradient_float(hash.y, x, y, z), mx_gradient_float(hash.z, x, y, z));
}
// Scaling factors to normalize the result of gradients above.
// These factors were experimentally calculated to be:
//    2D:   0.6616
//    3D:   0.9820
float mx_gradient_scale2d(float v) { return 0.6616 * v; }
float mx_gradient_scale3d(float v) { return 0.9820 * v; }
vec3 mx_gradient_scale2d(vec3 v) { return 0.6616 * v; }
vec3 mx_gradient_scale3d(vec3 v) { return 0.9820 * v; }

/// Bitwise circular rotation left by k bits (for 32 bit unsigned integers)
uint mx_rotl32(uint x, int k)
{
    return (x<<k) | (x>>(32-k));
}

void mx_bjmix(inout uint a, inout uint b, inout uint c)
{
    a -= c; a ^= mx_rotl32(c, 4); c += b;
    b -= a; b ^= mx_rotl32(a, 6); a += c;
    c -= b; c ^= mx_rotl32(b, 8); b += a;
    a -= c; a ^= mx_rotl32(c,16); c += b;
    b -= a; b ^= mx_rotl32(a,19); a += c;
    c -= b; c ^= mx_rotl32(b, 4); b += a;
}

// Mix up and combine the bits of a, b, and c (doesn't change them, but
// returns a hash of those three original values).
uint mx_bjfinal(uint a, uint b, uint c)
{
    c ^= b; c -= mx_rotl32(b,14);
    a ^= c; a -= mx_rotl32(c,11);
    b ^= a; b -= mx_rotl32(a,25);
    c ^= b; c -= mx_rotl32(b,16);
    a ^= c; a -= mx_rotl32(c,4);
    b ^= a; b -= mx_rotl32(a,14);
    c ^= b; c -= mx_rotl32(b,24);
    return c;
}

// Convert a 32 bit integer into a floating point number in [0,1]
float mx_bits_to_01(uint bits)
{
    return float(bits) / float(uint(0xffffffff));
}

float mx_fade(float t)
{
   return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

uint mx_hash_int(int x)
{
    uint len = 1u;
    uint seed = uint(0xdeadbeef) + (len << 2u) + 13u;
    return mx_bjfinal(seed+uint(x), seed, seed);
}

uint mx_hash_int(int x, int y)
{
    uint len = 2u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z)
{
    uint len = 3u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z, int xx)
{
    uint len = 4u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    mx_bjmix(a, b, c);
    a += uint(xx);
    return mx_bjfinal(a, b, c);
}

uint mx_hash_int(int x, int y, int z, int xx, int yy)
{
    uint len = 5u;
    uint a, b, c;
    a = b = c = uint(0xdeadbeef) + (len << 2u) + 13u;
    a += uint(x);
    b += uint(y);
    c += uint(z);
    mx_bjmix(a, b, c);
    a += uint(xx);
    b += uint(yy);
    return mx_bjfinal(a, b, c);
}

uvec3 mx_hash_vec3(int x, int y)
{
    uint h = mx_hash_int(x, y);
    // we only need the low-order bits to be random, so split out
    // the 32 bit result into 3 parts for each channel
    uvec3 result;
    result.x = (h      ) & 0xFFu;
    result.y = (h >> 8 ) & 0xFFu;
    result.z = (h >> 16) & 0xFFu;
    return result;
}

uvec3 mx_hash_vec3(int x, int y, int z)
{
    uint h = mx_hash_int(x, y, z);
    // we only need the low-order bits to be random, so split out
    // the 32 bit result into 3 parts for each channel
    uvec3 result;
    result.x = (h      ) & 0xFFu;
    result.y = (h >> 8 ) & 0xFFu;
    result.z = (h >> 16) & 0xFFu;
    return result;
}

float mx_perlin_noise_float(vec2 p)
{
    int X, Y;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float result = mx_bilerp(
        mx_gradient_float(mx_hash_int(X  , Y  ), fx    , fy     ),
        mx_gradient_float(mx_hash_int(X+1, Y  ), fx-1.0, fy     ),
        mx_gradient_float(mx_hash_int(X  , Y+1), fx    , fy-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y+1), fx-1.0, fy-1.0),
        u, v);
    return mx_gradient_scale2d(result);
}

float mx_perlin_noise_float(vec3 p)
{
    int X, Y, Z;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float fz = mx_floorfrac(p.z, Z);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float w = mx_fade(fz);
    float result = mx_trilerp(
        mx_gradient_float(mx_hash_int(X  , Y  , Z  ), fx    , fy    , fz     ),
        mx_gradient_float(mx_hash_int(X+1, Y  , Z  ), fx-1.0, fy    , fz     ),
        mx_gradient_float(mx_hash_int(X  , Y+1, Z  ), fx    , fy-1.0, fz     ),
        mx_gradient_float(mx_hash_int(X+1, Y+1, Z  ), fx-1.0, fy-1.0, fz     ),
        mx_gradient_float(mx_hash_int(X  , Y  , Z+1), fx    , fy    , fz-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y  , Z+1), fx-1.0, fy    , fz-1.0),
        mx_gradient_float(mx_hash_int(X  , Y+1, Z+1), fx    , fy-1.0, fz-1.0),
        mx_gradient_float(mx_hash_int(X+1, Y+1, Z+1), fx-1.0, fy-1.0, fz-1.0),
        u, v, w);
    return mx_gradient_scale3d(result);
}

vec3 mx_perlin_noise_vec3(vec2 p)
{
    int X, Y;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    vec3 result = mx_bilerp(
        mx_gradient_vec3(mx_hash_vec3(X  , Y  ), fx    , fy     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  ), fx-1.0, fy     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1), fx    , fy-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1), fx-1.0, fy-1.0),
        u, v);
    return mx_gradient_scale2d(result);
}

vec3 mx_perlin_noise_vec3(vec3 p)
{
    int X, Y, Z;
    float fx = mx_floorfrac(p.x, X);
    float fy = mx_floorfrac(p.y, Y);
    float fz = mx_floorfrac(p.z, Z);
    float u = mx_fade(fx);
    float v = mx_fade(fy);
    float w = mx_fade(fz);
    vec3 result = mx_trilerp(
        mx_gradient_vec3(mx_hash_vec3(X  , Y  , Z  ), fx    , fy    , fz     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  , Z  ), fx-1.0, fy    , fz     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1, Z  ), fx    , fy-1.0, fz     ),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1, Z  ), fx-1.0, fy-1.0, fz     ),
        mx_gradient_vec3(mx_hash_vec3(X  , Y  , Z+1), fx    , fy    , fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y  , Z+1), fx-1.0, fy    , fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X  , Y+1, Z+1), fx    , fy-1.0, fz-1.0),
        mx_gradient_vec3(mx_hash_vec3(X+1, Y+1, Z+1), fx-1.0, fy-1.0, fz-1.0),
        u, v, w);
    return mx_gradient_scale3d(result);
}

float mx_cell_noise_float(float p)
{
    int ix = mx_floor(p);
    return mx_bits_to_01(mx_hash_int(ix));
}

float mx_cell_noise_float(vec2 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    return mx_bits_to_01(mx_hash_int(ix, iy));
}

float mx_cell_noise_float(vec3 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    return mx_bits_to_01(mx_hash_int(ix, iy, iz));
}

float mx_cell_noise_float(vec4 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    int iw = mx_floor(p.w);
    return mx_bits_to_01(mx_hash_int(ix, iy, iz, iw));
}

vec3 mx_cell_noise_vec3(float p)
{
    int ix = mx_floor(p);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, 0)),
            mx_bits_to_01(mx_hash_int(ix, 1)),
            mx_bits_to_01(mx_hash_int(ix, 2))
    );
}

vec3 mx_cell_noise_vec3(vec2 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, 2))
    );
}

vec3 mx_cell_noise_vec3(vec3 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, 2))
    );
}

vec3 mx_cell_noise_vec3(vec4 p)
{
    int ix = mx_floor(p.x);
    int iy = mx_floor(p.y);
    int iz = mx_floor(p.z);
    int iw = mx_floor(p.w);
    return vec3(
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 0)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 1)),
            mx_bits_to_01(mx_hash_int(ix, iy, iz, iw, 2))
    );
}

float mx_fractal2d_noise_float(vec2 p, int octaves, float lacunarity, float diminish)
{
    float result = 0.0;
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_float(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec3 mx_fractal2d_noise_vec3(vec2 p, int octaves, float lacunarity, float diminish)
{
    vec3 result = vec3(0.0);
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_vec3(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec2 mx_fractal2d_noise_vec2(vec2 p, int octaves, float lacunarity, float diminish)
{
    return vec2(mx_fractal2d_noise_float(p, octaves, lacunarity, diminish),
                mx_fractal2d_noise_float(p+vec2(19, 193), octaves, lacunarity, diminish));
}

vec4 mx_fractal2d_noise_vec4(vec2 p, int octaves, float lacunarity, float diminish)
{
    vec3  c = mx_fractal2d_noise_vec3(p, octaves, lacunarity, diminish);
    float f = mx_fractal2d_noise_float(p+vec2(19, 193), octaves, lacunarity, diminish);
    return vec4(c, f);
}

float mx_fractal3d_noise_float(vec3 p, int octaves, float lacunarity, float diminish)
{
    float result = 0.0;
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_float(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec3 mx_fractal3d_noise_vec3(vec3 p, int octaves, float lacunarity, float diminish)
{
    vec3 result = vec3(0.0);
    float amplitude = 1.0;
    for (int i = 0;  i < octaves; ++i)
    {
        result += amplitude * mx_perlin_noise_vec3(p);
        amplitude *= diminish;
        p *= lacunarity;
    }
    return result;
}

vec2 mx_fractal3d_noise_vec2(vec3 p, int octaves, float lacunarity, float diminish)
{
    return vec2(mx_fractal3d_noise_float(p, octaves, lacunarity, diminish),
                mx_fractal3d_noise_float(p+vec3(19, 193, 17), octaves, lacunarity, diminish));
}

vec4 mx_fractal3d_noise_vec4(vec3 p, int octaves, float lacunarity, float diminish)
{
    vec3  c = mx_fractal3d_noise_vec3(p, octaves, lacunarity, diminish);
    float f = mx_fractal3d_noise_float(p+vec3(19, 193, 17), octaves, lacunarity, diminish);
    return vec4(c, f);
}

vec2 mx_worley_cell_position(int x, int y, int xoff, int yoff, float jitter)
{
    vec3  tmp = mx_cell_noise_vec3(vec2(x+xoff, y+yoff));
    vec2  off = vec2(tmp.x, tmp.y);

    off -= 0.5f;
    off *= jitter;
    off += 0.5f;

    return vec2(float(x), float(y)) + off;
}

vec3 mx_worley_cell_position(int x, int y, int z, int xoff, int yoff, int zoff, float jitter)
{
    vec3  off = mx_cell_noise_vec3(vec3(x+xoff, y+yoff, z+zoff));

    off -= 0.5f;
    off *= jitter;
    off += 0.5f;

    return vec3(float(x), float(y), float(z)) + off;
}

float mx_worley_distance(vec2 p, int x, int y, int xoff, int yoff, float jitter, int metric)
{
    vec2 cellpos = mx_worley_cell_position(x, y, xoff, yoff, jitter);
    vec2 diff = cellpos - p;
    if (metric == 2)
        return abs(diff.x) + abs(diff.y);       // Manhattan distance
    if (metric == 3)
        return max(abs(diff.x), abs(diff.y));   // Chebyshev distance
    // Either Euclidean or Distance^2
    return dot(diff, diff);
}

float mx_worley_distance(vec3 p, int x, int y, int z, int xoff, int yoff, int zoff, float jitter, int metric)
{
    vec3 cellpos = mx_worley_cell_position(x, y, z, xoff, yoff, zoff, jitter);
    vec3 diff = cellpos - p;
    if (metric == 2)
        return abs(diff.x) + abs(diff.y) + abs(diff.z); // Manhattan distance
    if (metric == 3)
        return max(max(abs(diff.x), abs(diff.y)), abs(diff.z)); // Chebyshev distance
    // Either Euclidean or Distance^2
    return dot(diff, diff);
}

float mx_worley_noise_float(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    float dist;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    float sqdist = 1e6f;        // Some big number for jitter > 1 (not all GPUs may be IEEE)
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if(dist < sqdist)
            {
                sqdist = dist;
                minpos = cellpos;
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_float(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec2 mx_worley_noise_vec2(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    vec2 sqdist = vec2(1e6f, 1e6f);
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if (dist < sqdist.x)
            {
                sqdist.y = sqdist.x;
                sqdist.x = dist;
                minpos = cellpos;
            }
            else if (dist < sqdist.y)
            {
                sqdist.y = dist;
            }
        }
    }
    if (style == 1)
    {
        vec3 tmp = mx_cell_noise_vec3(minpos + p);
        return vec2(tmp.x,tmp.y);
    }
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec3 mx_worley_noise_vec3(vec2 p, float jitter, int style, int metric)
{
    int X, Y;
    vec2 localpos = vec2(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y));
    vec3 sqdist = vec3(1e6f, 1e6f, 1e6f);
    vec2 minpos = vec2(0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            float dist = mx_worley_distance(localpos, x, y, X, Y, jitter, metric);
            vec2 cellpos = mx_worley_cell_position(x, y, X, Y, jitter) - localpos;
            if (dist < sqdist.x)
            {
                sqdist.z = sqdist.y;
                sqdist.y = sqdist.x;
                sqdist.x = dist;
                minpos = cellpos;
            }
            else if (dist < sqdist.y)
            {
                sqdist.z = sqdist.y;
                sqdist.y = dist;
            }
            else if (dist < sqdist.z)
            {
                sqdist.z = dist;
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_vec3(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

float mx_worley_noise_float(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    float sqdist = 1e6f;
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if(dist < sqdist)
                {
                    sqdist = dist;
                    minpos = cellpos;
                }
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_float(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec2 mx_worley_noise_vec2(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    vec2 sqdist = vec2(1e6f, 1e6f);
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if (dist < sqdist.x)
                {
                    sqdist.y = sqdist.x;
                    sqdist.x = dist;
                    minpos = cellpos;
                }
                else if (dist < sqdist.y)
                {
                    sqdist.y = dist;
                }
            }
        }
    }
    if (style == 1)
    {
        vec3 tmp = mx_cell_noise_vec3(minpos + p);
        return vec2(tmp.x,tmp.y);
    }
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

vec3 mx_worley_noise_vec3(vec3 p, float jitter, int style, int metric)
{
    int X, Y, Z;
    vec3 localpos = vec3(mx_floorfrac(p.x, X), mx_floorfrac(p.y, Y), mx_floorfrac(p.z, Z));
    vec3 sqdist = vec3(1e6f, 1e6f, 1e6f);
    vec3 minpos = vec3(0,0,0);
    for (int x = -1; x <= 1; ++x)
    {
        for (int y = -1; y <= 1; ++y)
        {
            for (int z = -1; z <= 1; ++z)
            {
                float dist = mx_worley_distance(localpos, x, y, z, X, Y, Z, jitter, metric);
                vec3 cellpos = mx_worley_cell_position(x, y, z, X, Y, Z, jitter) - localpos;
                if (dist < sqdist.x)
                {
                    sqdist.z = sqdist.y;
                    sqdist.y = sqdist.x;
                    sqdist.x = dist;
                    minpos = cellpos;
                }
                else if (dist < sqdist.y)
                {
                    sqdist.z = sqdist.y;
                    sqdist.y = dist;
                }
                else if (dist < sqdist.z)
                {
                    sqdist.z = dist;
                }
            }
        }
    }
    if (style == 1)
        return mx_cell_noise_vec3(minpos + p);
    else
    {
        if (metric == 0)
            sqdist = sqrt(sqdist);
        return sqdist;
    }
}

void mx_fractal3d_float(float amplitude, int octaves, float lacunarity, float diminish, vec3 position, out float result)
{
    float value = mx_fractal3d_noise_float(position, octaves, lacunarity, diminish);
    result = value * amplitude;
}

vec2 mx_transform_uv(vec2 uv, vec2 uv_scale, vec2 uv_offset)
{
    uv = uv * uv_scale + uv_offset;
    return uv;
}

void mx_image_float(sampler2D tex_sampler, int layer, float defaultval, vec2 texcoord, int uaddressmode, int vaddressmode, int filtertype, int framerange, int frameoffset, int frameendaction, vec2 uv_scale, vec2 uv_offset, out float result)
{
    vec2 uv = mx_transform_uv(texcoord, uv_scale, uv_offset);
    result = texture(tex_sampler, uv).r;
}

// These are defined based on the HwShaderGenerator::ClosureContextType enum
// if that changes - these need to be updated accordingly.

#define CLOSURE_TYPE_DEFAULT 0
#define CLOSURE_TYPE_REFLECTION 1
#define CLOSURE_TYPE_TRANSMISSION 2
#define CLOSURE_TYPE_INDIRECT 3
#define CLOSURE_TYPE_EMISSION 4

struct ClosureData {
    int closureType;
    vec3 L;
    vec3 V;
    vec3 N;
    vec3 P;
    float occlusion;
};

void mx_conductor_bsdf(ClosureData closureData, float weight, vec3 ior_n, vec3 ior_k, vec2 roughness, float thinfilm_thickness, float thinfilm_ior, vec3 N, vec3 X, int distribution, inout BSDF bsdf)
{
    bsdf.throughput = vec3(0.0);

    if (weight < M_FLOAT_EPS)
    {
        return;
    }

    vec3 V = closureData.V;
    vec3 L = closureData.L;

    N = mx_forward_facing_normal(N, V);
    float NdotV = clamp(dot(N, V), M_FLOAT_EPS, 1.0);

    FresnelData fd = mx_init_fresnel_conductor(ior_n, ior_k, thinfilm_thickness, thinfilm_ior);

    vec2 safeAlpha = clamp(roughness, M_FLOAT_EPS, 1.0);
    float avgAlpha = mx_average_alpha(safeAlpha);

    if (closureData.closureType == CLOSURE_TYPE_REFLECTION)
    {
        X = normalize(X - dot(X, N) * N);
        vec3 Y = cross(N, X);
        vec3 H = normalize(L + V);

        float NdotL = clamp(dot(N, L), M_FLOAT_EPS, 1.0);
        float VdotH = clamp(dot(V, H), M_FLOAT_EPS, 1.0);

        vec3 Ht = vec3(dot(H, X), dot(H, Y), dot(H, N));

        vec3 F = mx_compute_fresnel(VdotH, fd);
        float D = mx_ggx_NDF(Ht, safeAlpha);
        float G = mx_ggx_smith_G2(NdotL, NdotV, avgAlpha);

        vec3 comp = mx_ggx_energy_compensation(NdotV, avgAlpha, F);

        // Note: NdotL is cancelled out
        bsdf.response = D * F * G * comp * closureData.occlusion * weight / (4.0 * NdotV);
    }
    else if (closureData.closureType == CLOSURE_TYPE_INDIRECT)
    {
        vec3 F = mx_compute_fresnel(NdotV, fd);
        vec3 comp = mx_ggx_energy_compensation(NdotV, avgAlpha, F);
        vec3 Li = mx_environment_radiance(N, V, X, safeAlpha, distribution, fd);
        bsdf.response = Li * comp * weight;
    }
}


void mx_mix_bsdf(ClosureData closureData, BSDF fg, BSDF bg, float mixValue, out BSDF result)
{
    result.response = mix(bg.response, fg.response, mixValue);
    result.throughput = mix(bg.throughput, fg.throughput, mixValue);
}

// Clean-room ESSL implementation of Blender's 3D FBM Noise Texture.
//
// The integer lookup3 hash, 3D gradient selection, 0.982 scale, inclusive
// Detail octave count, and normalized/raw output modes mirror the portable
// CPU/GLSL oracle already used by the authored WebGL material adapters. This
// source is injected only for explicitly marked MaterialX fractal3d nodes;
// ordinary MaterialX fractal3d semantics are untouched.

uint mx_blender_rotl(uint value, uint amount)
{
    return (value << amount) | (value >> (32u - amount));
}

uvec3 mx_blender_finalize_hash(uvec3 value)
{
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 14u);
    value.x = (value.x ^ value.z) - mx_blender_rotl(value.z, 11u);
    value.y = (value.y ^ value.x) - mx_blender_rotl(value.x, 25u);
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 16u);
    value.x = (value.x ^ value.z) - mx_blender_rotl(value.z, 4u);
    value.y = (value.y ^ value.x) - mx_blender_rotl(value.x, 14u);
    value.z = (value.z ^ value.y) - mx_blender_rotl(value.y, 24u);
    return value;
}

uint mx_blender_hash3(uvec3 key)
{
    return mx_blender_finalize_hash(uvec3(0xdeadbeefu + 12u + 13u) + key).z;
}

float mx_blender_fade(float value)
{
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

float mx_blender_gradient(uint hash, vec3 point)
{
    uint h = hash & 15u;
    float u = h < 8u ? point.x : point.y;
    float v = h < 4u ? point.y : ((h == 12u || h == 14u) ? point.x : point.z);
    return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}

float mx_blender_signed_noise3(vec3 point)
{
    ivec3 cell = ivec3(floor(point));
    vec3 local = fract(point);
    vec3 weight = vec3(
        mx_blender_fade(local.x),
        mx_blender_fade(local.y),
        mx_blender_fade(local.z)
    );
    float n000 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 0, 0))), local - vec3(0, 0, 0));
    float n100 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 0, 0))), local - vec3(1, 0, 0));
    float n010 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 1, 0))), local - vec3(0, 1, 0));
    float n110 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 1, 0))), local - vec3(1, 1, 0));
    float n001 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 0, 1))), local - vec3(0, 0, 1));
    float n101 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 0, 1))), local - vec3(1, 0, 1));
    float n011 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(0, 1, 1))), local - vec3(0, 1, 1));
    float n111 = mx_blender_gradient(mx_blender_hash3(uvec3(cell + ivec3(1, 1, 1))), local - vec3(1, 1, 1));
    return 0.982 * mix(
        mix(mix(n000, n100, weight.x), mix(n010, n110, weight.x), weight.y),
        mix(mix(n001, n101, weight.x), mix(n011, n111, weight.x), weight.y),
        weight.z
    );
}

void mx_blender_fbm3_float(
    float amplitude,
    int octaves,
    float lacunarity,
    float diminish,
    vec3 position,
    out float result)
{
    float sum = 0.0;
    float maximum = 0.0;
    float current_amplitude = amplitude;
    float frequency = 1.0;
    for (int octave = 0; octave < 16; ++octave)
    {
        if (octave >= octaves)
        {
            break;
        }
        sum += current_amplitude * mx_blender_signed_noise3(position * frequency);
        maximum += current_amplitude;
        current_amplitude *= max(diminish, 0.0);
        frequency *= lacunarity;
    }
    result = maximum > 0.0 ? 0.5 * sum / maximum + 0.5 : 0.5;
}

void mx_blender_raw_fbm3_float(
    float amplitude,
    int octaves,
    float lacunarity,
    float diminish,
    vec3 position,
    out float result)
{
    result = 0.0;
    float current_amplitude = amplitude;
    float frequency = 1.0;
    for (int octave = 0; octave < 16; ++octave)
    {
        if (octave >= octaves)
        {
            break;
        }
        result += current_amplitude * mx_blender_signed_noise3(position * frequency);
        current_amplitude *= max(diminish, 0.0);
        frequency *= lacunarity;
    }
}

void main()
{
    vec3 geomprop_Nworld_out1 = normalize(normalWorld);
    vec3 geomprop_Tworld_out1 = normalize(tangentWorld);
    vec3 normal_object_out = normalize(normalObject);
    vec3 view_world_out = normalize(positionWorld - u_viewPosition);
    vec3 generated_object_position_out = positionObject;
    vec3 generated_extent_out = generated_extent_in1 - generated_extent_in2;
    vec3 normal_world_out = (u_worldInverseTransposeMatrix * vec4(normal_object_out, 0.0)).xyz;
    normal_world_out = normalize(normal_world_out);
    vec3 generated_offset_out = generated_object_position_out - generated_offset_in2;
    vec3 generated_safe_extent_out = max(generated_extent_out, generated_safe_extent_in2);
    float normal_dot_view_out = dot(normal_world_out, view_world_out);
    vec3 generated_coordinate_out = generated_offset_out / generated_safe_extent_out;
    float cosine_out = abs(normal_dot_view_out);
    vec3 mapping_scale_out = generated_coordinate_out * mapping_scale_in2;
    float cosine_squared_out = cosine_out * cosine_out;
    float mapping_length_out = length(mapping_scale_out);
    float g_squared_out = cosine_squared_out + g_squared_in2;
    vec3 mapping_length_vector_out = vec3(0.0);
    NG_convert_float_vector3(mapping_length_out, mapping_length_vector_out);
    float g_out = sqrt(g_squared_out);
    vec3 length_mix_out = mix(mapping_scale_out, mapping_length_vector_out, length_mix_mix);
    float g_minus_cosine_out = g_out - cosine_out;
    float g_plus_cosine_out = g_out + cosine_out;
    vec3 noise_position_out = length_mix_out * noise_position_in2;
    float cosine_g_minus_out = cosine_out * g_minus_cosine_out;
    float a_out = g_minus_cosine_out / g_plus_cosine_out;
    float cosine_g_plus_out = cosine_out * g_plus_cosine_out;
    float blender_fbm3_gold_brushed_noise_out = 0.0;
    mx_blender_fbm3_float(blender_fbm3_gold_brushed_noise_amplitude, blender_fbm3_gold_brushed_noise_octaves, blender_fbm3_gold_brushed_noise_lacunarity, blender_fbm3_gold_brushed_noise_diminish, noise_position_out, blender_fbm3_gold_brushed_noise_out);
    float b_denominator_out = cosine_g_minus_out + b_denominator_in2;
    float a_squared_out = a_out * a_out;
    float b_numerator_out = cosine_g_plus_out - b_numerator_in2;
    float brushed_gate_unclamped_out = brushed_gate_unclamped_outlow + (blender_fbm3_gold_brushed_noise_out - brushed_gate_unclamped_inlow) * (brushed_gate_unclamped_outhigh - brushed_gate_unclamped_outlow) / (brushed_gate_unclamped_inhigh - brushed_gate_unclamped_inlow);
    float half_a_squared_out = half_a_squared_in1 * a_squared_out;
    float b_out = b_numerator_out / b_denominator_out;
    float brushed_gate_out = clamp(brushed_gate_unclamped_out, brushed_gate_low, brushed_gate_high);
    float b_squared_out = b_out * b_out;
    float brushed_noise_contribution_out = brushed_gate_out * blender_fbm3_gold_brushed_noise_out;
    float one_plus_b_squared_out = one_plus_b_squared_in1 + b_squared_out;
    float brushed_add_out = brushed_add_in1 + brushed_noise_contribution_out;
    float layer_weight_fresnel_out = half_a_squared_out * one_plus_b_squared_out;
    float one_minus_brushed_add_out = one_minus_brushed_add_in1 - brushed_add_out;
    float one_minus_fresnel_out = one_minus_fresnel_in1 - layer_weight_fresnel_out;
    float lut_scaled_factor_out = layer_weight_fresnel_out * lut_scaled_factor_in2;
    float lut_centered_factor_out = lut_scaled_factor_out + lut_centered_factor_in2;
    vec2 lut_uv_out = vec2(lut_centered_factor_out,lut_uv_in2);
    float curve_ramp_response_out = 0.0;
    mx_image_float(curve_ramp_response_file, curve_ramp_response_layer, curve_ramp_response_default, lut_uv_out, curve_ramp_response_uaddressmode, curve_ramp_response_vaddressmode, curve_ramp_response_filtertype, curve_ramp_response_framerange, curve_ramp_response_frameoffset, curve_ramp_response_frameendaction, curve_ramp_response_uv_scale, curve_ramp_response_uv_offset, curve_ramp_response_out);
    float fresnel_response_out = layer_weight_fresnel_out * curve_ramp_response_out;
    float roughness_factor_out = one_minus_fresnel_out + fresnel_response_out;
    float authored_base_roughness_out = authored_base_roughness_in1 * roughness_factor_out;
    float one_minus_base_roughness_out = one_minus_base_roughness_in1 - authored_base_roughness_out;
    float screen_complement_out = one_minus_base_roughness_out * one_minus_brushed_add_out;
    float perceptual_roughness_out = perceptual_roughness_in1 - screen_complement_out;
    float active_perceptual_roughness_out = perceptual_roughness_out * active_perceptual_roughness_in2;
    float roughness_025_out = active_perceptual_roughness_out * roughness_025_in2;
    float roughness_050_out = active_perceptual_roughness_out * roughness_050_in2;
    float roughness_075_out = active_perceptual_roughness_out * roughness_075_in2;
    float alpha_100_scalar_out = active_perceptual_roughness_out * active_perceptual_roughness_out;
    float alpha_025_scalar_out = roughness_025_out * roughness_025_out;
    float alpha_050_scalar_out = roughness_050_out * roughness_050_out;
    float alpha_075_scalar_out = roughness_075_out * roughness_075_out;
    vec2 alpha_100_out = vec2(alpha_100_scalar_out,alpha_100_scalar_out);
    vec2 alpha_025_out = vec2(alpha_025_scalar_out,alpha_025_scalar_out);
    vec2 alpha_050_out = vec2(alpha_050_scalar_out,alpha_050_scalar_out);
    vec2 alpha_075_out = vec2(alpha_075_scalar_out,alpha_075_scalar_out);
    surfaceshader surface_physical_gold_active_non_image_out = surfaceshader(vec3(0.0),vec3(0.0));
    {
        vec3 N = normalize(normalWorld);
        vec3 V = normalize(u_viewPosition - positionWorld);
        vec3 P = positionWorld;
        vec3 L = vec3(0,0,0);;
        float occlusion = 1.0;

        float surfaceOpacity = surface_physical_gold_active_non_image_opacity;

        // Shadow occlusion

        // Light loop
        int numLights = numActiveLightSources();
        lightshader lightShader;
        for (int activeLightIndex = 0; activeLightIndex < numLights; ++activeLightIndex)
        {
            sampleLightSource(u_lightData[activeLightIndex], positionWorld, lightShader);
            L = lightShader.direction;

            // Calculate the BSDF response for this light source
            ClosureData closureData = ClosureData(CLOSURE_TYPE_REFLECTION, L, V, N, P, occlusion);
            BSDF roughness_100_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_100_conductor_weight, roughness_100_conductor_ior, roughness_100_conductor_extinction, alpha_100_out, roughness_100_conductor_thinfilm_thickness, roughness_100_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_100_conductor_distribution, roughness_100_conductor_out);
            BSDF roughness_075_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_075_conductor_weight, roughness_075_conductor_ior, roughness_075_conductor_extinction, alpha_075_out, roughness_075_conductor_thinfilm_thickness, roughness_075_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_075_conductor_distribution, roughness_075_conductor_out);
            BSDF roughness_050_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_050_conductor_weight, roughness_050_conductor_ior, roughness_050_conductor_extinction, alpha_050_out, roughness_050_conductor_thinfilm_thickness, roughness_050_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_050_conductor_distribution, roughness_050_conductor_out);
            BSDF roughness_025_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_025_conductor_weight, roughness_025_conductor_ior, roughness_025_conductor_extinction, alpha_025_out, roughness_025_conductor_thinfilm_thickness, roughness_025_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_025_conductor_distribution, roughness_025_conductor_out);
            BSDF mix_025_050_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_050_conductor_out, roughness_025_conductor_out, mix_025_050_mix, mix_025_050_out);
            BSDF mix_050_075_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_075_conductor_out, mix_025_050_out, mix_050_075_mix, mix_050_075_out);
            BSDF mix_075_100_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_100_conductor_out, mix_050_075_out, mix_075_100_mix, mix_075_100_out);

            // Accumulate the light's contribution
            surface_physical_gold_active_non_image_out.color += lightShader.intensity * mix_075_100_out.response;
        }

        // Ambient occlusion
        occlusion = 1.0;

        // Add environment contribution
        {
            ClosureData closureData = ClosureData(CLOSURE_TYPE_INDIRECT, L, V, N, P, occlusion);
            BSDF roughness_100_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_100_conductor_weight, roughness_100_conductor_ior, roughness_100_conductor_extinction, alpha_100_out, roughness_100_conductor_thinfilm_thickness, roughness_100_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_100_conductor_distribution, roughness_100_conductor_out);
            BSDF roughness_075_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_075_conductor_weight, roughness_075_conductor_ior, roughness_075_conductor_extinction, alpha_075_out, roughness_075_conductor_thinfilm_thickness, roughness_075_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_075_conductor_distribution, roughness_075_conductor_out);
            BSDF roughness_050_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_050_conductor_weight, roughness_050_conductor_ior, roughness_050_conductor_extinction, alpha_050_out, roughness_050_conductor_thinfilm_thickness, roughness_050_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_050_conductor_distribution, roughness_050_conductor_out);
            BSDF roughness_025_conductor_out = BSDF(vec3(0.0),vec3(1.0));
            mx_conductor_bsdf(closureData, roughness_025_conductor_weight, roughness_025_conductor_ior, roughness_025_conductor_extinction, alpha_025_out, roughness_025_conductor_thinfilm_thickness, roughness_025_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_025_conductor_distribution, roughness_025_conductor_out);
            BSDF mix_025_050_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_050_conductor_out, roughness_025_conductor_out, mix_025_050_mix, mix_025_050_out);
            BSDF mix_050_075_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_075_conductor_out, mix_025_050_out, mix_050_075_mix, mix_050_075_out);
            BSDF mix_075_100_out = BSDF(vec3(0.0),vec3(1.0));
            mx_mix_bsdf(closureData, roughness_100_conductor_out, mix_050_075_out, mix_075_100_mix, mix_075_100_out);

            surface_physical_gold_active_non_image_out.color += occlusion * mix_075_100_out.response;
        }

        // Calculate the BSDF transmission for viewing direction
        ClosureData closureData = ClosureData(CLOSURE_TYPE_TRANSMISSION, L, V, N, P, occlusion);
        BSDF roughness_100_conductor_out = BSDF(vec3(0.0),vec3(1.0));
        mx_conductor_bsdf(closureData, roughness_100_conductor_weight, roughness_100_conductor_ior, roughness_100_conductor_extinction, alpha_100_out, roughness_100_conductor_thinfilm_thickness, roughness_100_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_100_conductor_distribution, roughness_100_conductor_out);
        BSDF roughness_075_conductor_out = BSDF(vec3(0.0),vec3(1.0));
        mx_conductor_bsdf(closureData, roughness_075_conductor_weight, roughness_075_conductor_ior, roughness_075_conductor_extinction, alpha_075_out, roughness_075_conductor_thinfilm_thickness, roughness_075_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_075_conductor_distribution, roughness_075_conductor_out);
        BSDF roughness_050_conductor_out = BSDF(vec3(0.0),vec3(1.0));
        mx_conductor_bsdf(closureData, roughness_050_conductor_weight, roughness_050_conductor_ior, roughness_050_conductor_extinction, alpha_050_out, roughness_050_conductor_thinfilm_thickness, roughness_050_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_050_conductor_distribution, roughness_050_conductor_out);
        BSDF roughness_025_conductor_out = BSDF(vec3(0.0),vec3(1.0));
        mx_conductor_bsdf(closureData, roughness_025_conductor_weight, roughness_025_conductor_ior, roughness_025_conductor_extinction, alpha_025_out, roughness_025_conductor_thinfilm_thickness, roughness_025_conductor_thinfilm_ior, geomprop_Nworld_out1, geomprop_Tworld_out1, roughness_025_conductor_distribution, roughness_025_conductor_out);
        BSDF mix_025_050_out = BSDF(vec3(0.0),vec3(1.0));
        mx_mix_bsdf(closureData, roughness_050_conductor_out, roughness_025_conductor_out, mix_025_050_mix, mix_025_050_out);
        BSDF mix_050_075_out = BSDF(vec3(0.0),vec3(1.0));
        mx_mix_bsdf(closureData, roughness_075_conductor_out, mix_025_050_out, mix_050_075_mix, mix_050_075_out);
        BSDF mix_075_100_out = BSDF(vec3(0.0),vec3(1.0));
        mx_mix_bsdf(closureData, roughness_100_conductor_out, mix_050_075_out, mix_075_100_mix, mix_075_100_out);
        surface_physical_gold_active_non_image_out.color += mix_075_100_out.response;

        // Compute and apply surface opacity
        {
            surface_physical_gold_active_non_image_out.color *= surfaceOpacity;
            surface_physical_gold_active_non_image_out.transparency = mix(vec3(1.0), surface_physical_gold_active_non_image_out.transparency, surfaceOpacity);
        }
    }

    material MetalPhysicalGoldActiveNonImage_out = surface_physical_gold_active_non_image_out;
    out1 = vec4(mx_srgb_encode(MetalPhysicalGoldActiveNonImage_out.color), 1.0);
}
