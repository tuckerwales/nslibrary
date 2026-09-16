cmake_minimum_required(VERSION 3.16)

option(PLATFORM_SWITCH "Build the Nintendo Switch .nro" OFF)

if (PLATFORM_SWITCH)
    set(BOREALIS_LIBRARY "${CMAKE_CURRENT_SOURCE_DIR}/lib/borealis/library")
    if (NOT EXISTS "${BOREALIS_LIBRARY}/CMakeLists.txt")
        message(FATAL_ERROR "Borealis submodule is missing. Run: git submodule update --init switch/lib/borealis")
    endif()
    # Sets BRLS_* / USE_* options the library CMakeLists expects (e.g. BRLS_UNITY_BUILD).
    include("${BOREALIS_LIBRARY}/cmake/commonOption.cmake")
    include("${BOREALIS_LIBRARY}/cmake/toolchain.cmake")
endif()

project(nslibrary VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(NSLIB_VERSION_MAJOR 0)
set(NSLIB_VERSION_MINOR 1)
set(NSLIB_VERSION_PATCH 1)
set(NSLIB_VERSION "${NSLIB_VERSION_MAJOR}.${NSLIB_VERSION_MINOR}.${NSLIB_VERSION_PATCH}")
set(NSLIB_TITLEID "01004E534C494200")
set_source_files_properties(source/update/tweetnacl.c PROPERTIES
    INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/source/update"
)

set(NSLIB_COMMON_SRC
    source/formats/pfs0.cpp
    source/formats/cnmt.cpp
    source/formats/ticket.cpp
    source/formats/meta.cpp
    source/formats/crypto.cpp
    source/formats/xci.cpp
    source/formats/ncz.cpp
    source/formats/container.cpp
    source/api/json.cpp
    source/api/protocol.cpp
    source/api/url.cpp
    source/install/preflight.cpp
    source/install/pipeline.cpp
    source/transport/usb_frame.cpp
    source/transport/resume.cpp
    source/update/tweetnacl.c
    source/update/randombytes.c
    source/update/ed25519.cpp
    source/update/manifest.cpp
    source/update/verify.cpp
)

if (PLATFORM_SWITCH)
    set(VERSION_MAJOR ${NSLIB_VERSION_MAJOR})
    set(VERSION_MINOR ${NSLIB_VERSION_MINOR})
    set(VERSION_ALTER ${NSLIB_VERSION_PATCH})
    set(PROJECT_AUTHOR "NSLibrary")
    set(PROJECT_ICON "${CMAKE_CURRENT_SOURCE_DIR}/resources/img/icon.jpg")
    set(PROJECT_RESOURCES "${CMAKE_CURRENT_SOURCE_DIR}/resources")
    set(PROJECT_TITLEID ${NSLIB_TITLEID})

    # newlib does not declare fileno/fdopen the way fmt's os.cc expects.
    set(FMT_OS OFF CACHE BOOL "Disable fmt OS APIs on Switch/newlib" FORCE)

    add_subdirectory("${BOREALIS_LIBRARY}" EXCLUDE_FROM_ALL)

    find_package(PkgConfig REQUIRED)
    pkg_check_modules(CURL REQUIRED libcurl)
    pkg_check_modules(ZSTD REQUIRED libzstd)

    set(NSLIB_SWITCH_SRC
        ${NSLIB_COMMON_SRC}
        source/app/main.cpp
        source/app/services.cpp
        source/app/settings.cpp
        source/app/session.cpp
        source/transport/http.cpp
        source/transport/usb.cpp
        source/transport/usb_ds.cpp
        source/transport/discovery.cpp
        source/api/client.cpp
        source/api/poller.cpp
        source/install/engine.cpp
        source/install/app_record.cpp
        source/install/es.cpp
        source/installed/scanner.cpp
        source/ui/detail.cpp
        source/ui/icon_cache.cpp
        source/ui/connect.cpp
        source/ui/pair.cpp
        source/ui/library_tab.cpp
        source/ui/updates_tab.cpp
        source/ui/queue_tab.cpp
        source/ui/installed_tab.cpp
        source/ui/missing_tab.cpp
        source/ui/settings_tab.cpp
        source/ui/progress.cpp
        source/update/http_get.cpp
        source/update/apply.cpp
        "${BOREALIS_LIBRARY}/lib/platforms/switch/switch_wrapper.c"
    )

    program_target(${PROJECT_NAME} "${NSLIB_SWITCH_SRC}")
    set_target_properties(${PROJECT_NAME} PROPERTIES CXX_STANDARD 17)

    target_include_directories(${PROJECT_NAME} PRIVATE
        source
        ${CURL_INCLUDE_DIRS}
        ${ZSTD_INCLUDE_DIRS}
    )
    target_compile_definitions(${PROJECT_NAME} PRIVATE
        NSLIB_VERSION="${NSLIB_VERSION}"
        NSLIB_TITLEID="${NSLIB_TITLEID}"
        NSLIB_GITHUB_REPO="tuckerwales/nslibrary"
    )
    target_compile_options(${PROJECT_NAME} PRIVATE
        -ffunction-sections
        -fdata-sections
        ${CURL_CFLAGS_OTHER}
    )
    target_link_libraries(${PROJECT_NAME} PRIVATE
        borealis
        ${CURL_LIBRARIES}
        ${ZSTD_LIBRARIES}
        glfw3 EGL glapi drm_nouveau
        nx m
    )
    target_link_directories(${PROJECT_NAME} PRIVATE
        ${CURL_LIBRARY_DIRS}
        ${ZSTD_LIBRARY_DIRS}
    )

    add_executable(nslibrary-forwarder source/forwarder/main.cpp)
    set_target_properties(nslibrary-forwarder PROPERTIES SUFFIX ".elf")
    target_link_libraries(nslibrary-forwarder PRIVATE nx)
    add_custom_command(TARGET nslibrary-forwarder POST_BUILD
        COMMAND ${CMAKE_OBJCOPY} -O binary
            $<TARGET_FILE:nslibrary-forwarder>
            ${CMAKE_BINARY_DIR}/forwarder-main
        COMMENT "Extracting forwarder main"
    )

    set(NSLIB_ROMFS "${CMAKE_BINARY_DIR}/romfs")
    add_custom_target(${PROJECT_NAME}.nro DEPENDS ${PROJECT_NAME}
        COMMAND ${NX_NACPTOOL_EXE} --create "NSLibrary" "${PROJECT_AUTHOR}"
            "${NSLIB_VERSION}" ${PROJECT_NAME}.nacp --titleid=${PROJECT_TITLEID}
        COMMAND "${CMAKE_COMMAND}" -E rm -rf "${NSLIB_ROMFS}"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${BOREALIS_LIBRARY}/../resources" "${NSLIB_ROMFS}"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${PROJECT_RESOURCES}" "${NSLIB_ROMFS}"
        COMMAND "${CMAKE_COMMAND}" -E remove_directory "${NSLIB_ROMFS}/font"
        COMMAND ${NX_ELF2NRO_EXE} ${PROJECT_NAME}.elf ${PROJECT_NAME}.nro
            --icon=${PROJECT_ICON} --nacp=${PROJECT_NAME}.nacp
            --romfsdir=${NSLIB_ROMFS}
        WORKING_DIRECTORY "${CMAKE_BINARY_DIR}"
        COMMENT "Building ${PROJECT_NAME}.nro"
    )
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(ZSTD REQUIRED libzstd)
    find_package(Threads REQUIRED)

    add_executable(nslib-switch-tests
        ${NSLIB_COMMON_SRC}
        tests/main.cpp
        tests/pfs0_test.cpp
        tests/cnmt_test.cpp
        tests/ticket_test.cpp
        tests/json_test.cpp
        tests/protocol_test.cpp
        tests/url_test.cpp
        tests/meta_test.cpp
        tests/crypto_test.cpp
        tests/hfs0_test.cpp
        tests/xci_test.cpp
        tests/ncz_test.cpp
        tests/preflight_test.cpp
        tests/pipeline_test.cpp
        tests/usb_frame_test.cpp
        tests/resume_test.cpp
        tests/update_test.cpp
    )
    target_include_directories(nslib-switch-tests PRIVATE
        source
        tests
        ${ZSTD_INCLUDE_DIRS}
    )
    target_compile_definitions(nslib-switch-tests PRIVATE
        GOLDEN_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../packages/shared/golden"
        FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/golden"
        NSLIB_VERSION="${NSLIB_VERSION}"
        NSLIB_GITHUB_REPO="tuckerwales/nslibrary"
    )
    target_link_libraries(nslib-switch-tests PRIVATE ${ZSTD_LIBRARIES} Threads::Threads)
    target_link_directories(nslib-switch-tests PRIVATE ${ZSTD_LIBRARY_DIRS})
    enable_testing()
    add_test(NAME nslib-switch-tests COMMAND nslib-switch-tests)
endif()
