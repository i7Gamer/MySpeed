/*
 * Candidate-neutral Windows x64 CPU-floor probe for MSVC.
 *
 * Compile this source once per PROBE_* definition. Instruction controls do
 * not inspect CPUID and do not catch exceptions. The external harness must
 * observe process termination and independently disassemble every binary.
 */

#include <immintrin.h>
#include <intrin.h>
#include <stdint.h>
#include <stdio.h>

#define PROBE_SCHEMA_VERSION 1
#define KNOWN_GOOD_RESULT 42ULL
#define KNOWN_BAD_RESULT 13ULL
#define KNOWN_BAD_EXIT_CODE 19
#define RESULT_MISMATCH_EXIT_CODE 23
#define SSE42_RESULT 2276049685ULL
#define SSE42_SEED 0x12345678U
#define POPCNT_RESULT 32ULL
#define VECTOR_RESULT 72ULL
#define SSE42_BIT 20
#define POPCNT_BIT 23
#define OSXSAVE_BIT 27
#define AVX_BIT 28
#define AVX2_BIT 5
#define LEAF_ONE 1
#define LEAF_SEVEN 7
#define SUBLEAF_ZERO 0
#define XCR_XFEATURE_ENABLED_MASK 0
#define VECTOR_LANES 8

#if !defined(_MSC_VER) || !defined(_M_X64)
#error Build this probe only with the MSVC x64 compiler.
#endif

#if (defined(PROBE_CPUID) + defined(PROBE_KNOWN_GOOD) + defined(PROBE_KNOWN_BAD) + \
     defined(PROBE_ILLEGAL) + defined(PROBE_SSE42) + defined(PROBE_POPCNT) + \
     defined(PROBE_AVX) + defined(PROBE_AVX2)) != 1
#error Define exactly one PROBE_* mode.
#endif

#if defined(PROBE_AVX) && !defined(__AVX__)
#error PROBE_AVX requires the MSVC /arch:AVX option.
#endif

#if defined(PROBE_AVX2) && !defined(__AVX2__)
#error PROBE_AVX2 requires the MSVC /arch:AVX2 option.
#endif

#if defined(PROBE_CPUID)
static const char *json_boolean(int value)
{
    return value ? "true" : "false";
}
#endif

#if defined(PROBE_KNOWN_GOOD) || defined(PROBE_KNOWN_BAD) || defined(PROBE_SSE42) || \
    defined(PROBE_POPCNT) || defined(PROBE_AVX) || defined(PROBE_AVX2)
static int write_control_result(const char *kind, unsigned __int64 result,
                                unsigned __int64 expected, int success_exit_code)
{
    printf("{\"schemaVersion\":%d,\"kind\":\"%s\",\"result\":%llu}\n",
           PROBE_SCHEMA_VERSION, kind, result);
    fflush(stdout);
    return result == expected ? success_exit_code : RESULT_MISMATCH_EXIT_CODE;
}
#endif

#if defined(PROBE_SSE42)
static volatile unsigned __int64 sse42_input = 0xf0f0f0f00f0f0f0fULL;
__declspec(noinline) static unsigned __int64 run_sse42(void)
{
    const unsigned __int64 input = sse42_input;
    return _mm_crc32_u64(SSE42_SEED, input);
}
#endif

#if defined(PROBE_POPCNT)
static volatile unsigned __int64 popcnt_input = 0xf0f0f0f00f0f0f0fULL;
__declspec(noinline) static unsigned __int64 run_popcnt(void)
{
    const unsigned __int64 input = popcnt_input;
    return __popcnt64(input);
}
#endif

#if defined(PROBE_AVX)
static volatile float avx_left[VECTOR_LANES] = {1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f, 8.0f};
static volatile float avx_right[VECTOR_LANES] = {8.0f, 7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f};
__declspec(noinline) static unsigned __int64 run_avx(void)
{
    float output[VECTOR_LANES];
    const __m256 left_vector = _mm256_setr_ps(avx_left[0], avx_left[1], avx_left[2], avx_left[3],
                                               avx_left[4], avx_left[5], avx_left[6], avx_left[7]);
    const __m256 right_vector = _mm256_setr_ps(avx_right[0], avx_right[1], avx_right[2], avx_right[3],
                                                avx_right[4], avx_right[5], avx_right[6], avx_right[7]);
    const __m256 sum = _mm256_add_ps(left_vector, right_vector);
    _mm256_storeu_ps(output, sum);
    return (unsigned __int64)(output[0] + output[1] + output[2] + output[3] +
                              output[4] + output[5] + output[6] + output[7]);
}
#endif

#if defined(PROBE_AVX2)
static volatile int avx2_left[VECTOR_LANES] = {1, 2, 3, 4, 5, 6, 7, 8};
static volatile int avx2_right[VECTOR_LANES] = {8, 7, 6, 5, 4, 3, 2, 1};
__declspec(noinline) static unsigned __int64 run_avx2(void)
{
    int output[VECTOR_LANES];
    const __m256i left_vector = _mm256_setr_epi32(avx2_left[0], avx2_left[1], avx2_left[2], avx2_left[3],
                                                  avx2_left[4], avx2_left[5], avx2_left[6], avx2_left[7]);
    const __m256i right_vector = _mm256_setr_epi32(avx2_right[0], avx2_right[1], avx2_right[2], avx2_right[3],
                                                   avx2_right[4], avx2_right[5], avx2_right[6], avx2_right[7]);
    const __m256i sum = _mm256_add_epi32(left_vector, right_vector);
    _mm256_storeu_si256((__m256i *)(void *)output, sum);
    return (unsigned __int64)(output[0] + output[1] + output[2] + output[3] +
                              output[4] + output[5] + output[6] + output[7]);
}
#endif

int main(void)
{
#if defined(PROBE_CPUID)
    int maximum[4];
    int leaf_one[4];
    int leaf_seven[4] = {0, 0, 0, 0};
    unsigned int maximum_basic_leaf;
    unsigned int leaf_one_ecx;
    unsigned int leaf_seven_ebx;
    unsigned __int64 xcr0 = 0ULL;
    int osxsave_enabled;
    char xcr0_json[sizeof("\"0x0000000000000000\"")];

    __cpuid(maximum, SUBLEAF_ZERO);
    maximum_basic_leaf = (unsigned int)maximum[0];
    __cpuidex(leaf_one, LEAF_ONE, SUBLEAF_ZERO);
    if (maximum_basic_leaf >= LEAF_SEVEN) {
        __cpuidex(leaf_seven, LEAF_SEVEN, SUBLEAF_ZERO);
    }
    leaf_one_ecx = (unsigned int)leaf_one[2];
    leaf_seven_ebx = (unsigned int)leaf_seven[1];
    osxsave_enabled = (leaf_one_ecx & (1U << OSXSAVE_BIT)) != 0U;
    if ((leaf_one_ecx & (1U << OSXSAVE_BIT)) != 0U) {
        xcr0 = _xgetbv(XCR_XFEATURE_ENABLED_MASK);
        sprintf_s(xcr0_json, sizeof xcr0_json, "\"0x%016llx\"", xcr0);
    } else {
        sprintf_s(xcr0_json, sizeof xcr0_json, "null");
    }
    printf("{\"schemaVersion\":%d,\"kind\":\"cpuid\",\"maxBasicLeaf\":%u,"
           "\"leaf1\":{\"eax\":\"0x%08x\",\"ebx\":\"0x%08x\",\"ecx\":\"0x%08x\",\"edx\":\"0x%08x\"},"
           "\"leaf7Subleaf0\":{\"eax\":\"0x%08x\",\"ebx\":\"0x%08x\",\"ecx\":\"0x%08x\",\"edx\":\"0x%08x\"},"
           "\"xcr0\":%s,"
           "\"features\":{\"sse42\":%s,\"popcnt\":%s,\"osxsave\":%s,\"avx\":%s,\"avx2\":%s}}\n",
           PROBE_SCHEMA_VERSION, maximum_basic_leaf,
           (unsigned int)leaf_one[0], (unsigned int)leaf_one[1], leaf_one_ecx, (unsigned int)leaf_one[3],
           (unsigned int)leaf_seven[0], leaf_seven_ebx, (unsigned int)leaf_seven[2], (unsigned int)leaf_seven[3],
           xcr0_json,
           json_boolean((leaf_one_ecx & (1U << SSE42_BIT)) != 0U),
           json_boolean((leaf_one_ecx & (1U << POPCNT_BIT)) != 0U),
           json_boolean(osxsave_enabled),
           json_boolean((leaf_one_ecx & (1U << AVX_BIT)) != 0U),
           json_boolean((leaf_seven_ebx & (1U << AVX2_BIT)) != 0U));
    return 0;
#elif defined(PROBE_KNOWN_GOOD)
    volatile unsigned int left = 40U;
    volatile unsigned int right = 2U;
    return write_control_result("known-good", left + right,
                                KNOWN_GOOD_RESULT, 0);
#elif defined(PROBE_KNOWN_BAD)
    volatile unsigned int value = 13U;
    return write_control_result("known-bad", value, KNOWN_BAD_RESULT,
                                KNOWN_BAD_EXIT_CODE);
#elif defined(PROBE_ILLEGAL)
    __ud2();
#elif defined(PROBE_SSE42)
    return write_control_result("sse42", run_sse42(), SSE42_RESULT, 0);
#elif defined(PROBE_POPCNT)
    return write_control_result("popcnt", run_popcnt(), POPCNT_RESULT, 0);
#elif defined(PROBE_AVX)
    return write_control_result("avx", run_avx(), VECTOR_RESULT, 0);
#elif defined(PROBE_AVX2)
    return write_control_result("avx2", run_avx2(), VECTOR_RESULT, 0);
#endif
}
