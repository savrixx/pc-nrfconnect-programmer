/* Copyright (c) 2015 - 2021, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/* eslint-disable import/no-cycle */

import nrfdl, {
    Device,
    Error as NrfdlError,
    FirmwareReadResult,
} from '@nordicsemiconductor/nrf-device-lib-js';
import { remote } from 'electron';
import fs from 'fs';
import MemoryMap, { MemoryBlocks } from 'nrf-intel-hex';
import { getDeviceLibContext, logger, usageData } from 'pc-nrfconnect-shared';

import { modemKnown } from '../reducers/modemReducer';
import {
    erasingEnd,
    erasingStart,
    loadingEnd,
    loadingStart,
    targetContentsKnown,
    targetInfoKnown,
    targetRegionsKnown,
    targetTypeKnown,
    targetWritableKnown,
    writingEnd,
    writingStart,
} from '../reducers/targetReducer';
import { RootState, TDispatch } from '../reducers/types';
import { targetWarningRemove } from '../reducers/warningReducer';
import {
    addCoreToDeviceInfo,
    CommunicationType,
    CoreDefinition,
    DeviceDefinition,
    getDeviceFromNrfdl,
    getDeviceInfoByJlink,
} from '../util/devices';
import sequence from '../util/promise';
import { getTargetRegions } from '../util/regions';
import { updateFileAppRegions } from './fileActions';
import { updateTargetWritable } from './targetActions';
import EventAction from './usageDataActions';

/**
 * Format serial number to string with padded zeros.
 *
 * @param {string | number} serialNumber input serial number
 * @returns {string} formatted serial number
 */
export const formatSerialNumber = (serialNumber: string | number) => {
    serialNumber =
        typeof serialNumber === 'number'
            ? serialNumber.toString()
            : serialNumber;

    return `000${serialNumber.substring(0, 9)}`;
};

/**
 *
 * Display some information about a DevKit. Called on a DevKit connection.
 * This also triggers reading the whole memory contents of the device.
 *
 * @returns {void}
 */
export const openDevice =
    () => async (dispatch: TDispatch, getState: () => RootState) => {
        const { device } = getState().app.target;
        if (!device) throw Error(`Failed to open: device not found`);

        dispatch(loadingStart());
        dispatch(targetWarningRemove());
        dispatch(
            targetTypeKnown({
                targetType: CommunicationType.JLINK,
                isRecoverable: true,
            })
        );
        logger.info(
            'Using @nordicsemiconductor/nrf-device-lib-js to communicate with target via JLink'
        );

        logDeviceInfo(device);
        let deviceInfo = getDeviceInfoByJlink(device);

        // Update modem target info according to detected device info
        dispatch(modemKnown(device.jlink.deviceFamily.includes('NRF91')));

        // By default readback protection is none
        let protectionStatus: nrfdl.ProtectionStatus =
            'NRFDL_PROTECTION_STATUS_NONE';

        try {
            logger.info('Loading readback protection status');
            protectionStatus =
                // TODO: fix type in nrfdl: snake_case
                (
                    await nrfdl.deviceControlGetProtectionStatus(
                        getDeviceLibContext(),
                        device.id
                    )
                ).protection_status;
            logger.info(`Readback protection status: ${protectionStatus}`);
        } catch (error) {
            dispatch(loadingEnd());
            usageData.sendErrorReport(
                `Failed to load readback protection status: ${error}`
            );
        }

        let coreName = 'Application';

        // TODO: fix type in nrfdl
        let deviceCoreInfo = await nrfdl.getDeviceCoreInfo(
            getDeviceLibContext(),
            device.id
        );
        deviceCoreInfo = { ...deviceCoreInfo, protectionStatus };
        deviceInfo = addCoreToDeviceInfo(deviceInfo, deviceCoreInfo, coreName);
        const isFamilyNrf53 = device.jlink.deviceFamily.includes('NRF53');

        // Since nRF53 family is dual core devices
        // It needs an additional check for readback protection on network core
        if (isFamilyNrf53) {
            coreName = 'Network';
            const coreNameConstant = 'NRFDL_DEVICE_CORE_NETWORK';
            // TODO: fix type in nrfdl
            deviceCoreInfo = await nrfdl.getDeviceCoreInfo(
                getDeviceLibContext(),
                device.id,
                'NRFDL_DEVICE_CORE_NETWORK'
            );
            try {
                protectionStatus = (
                    await nrfdl.deviceControlGetProtectionStatus(
                        getDeviceLibContext(),
                        device.id,
                        coreNameConstant
                    )
                ).protection_status;
            } catch (error) {
                dispatch(loadingEnd());
                usageData.sendErrorReport(
                    `Failed to load readback protection status on network core: ${error}`
                );
            }
            deviceCoreInfo = { ...deviceCoreInfo, protectionStatus };
            deviceInfo = addCoreToDeviceInfo(
                deviceInfo,
                deviceCoreInfo,
                coreName
            );
        }
        dispatch(targetInfoKnown(deviceInfo));

        const { autoRead } = getState().app.settings;
        if (autoRead) read();

        dispatch(updateTargetWritable());
        dispatch(loadingEnd());
    };

/**
 * Log the device information
 * @param {Device} device the input device from device lister
 * @returns {void}
 */
const logDeviceInfo = (device: Device) => {
    const {
        jlinkObFirmwareVersion,
        deviceFamily,
        deviceVersion,
        boardVersion,
    } = device.jlink;
    logger.info('JLink OB firmware version', jlinkObFirmwareVersion);
    usageData.sendUsageData(
        EventAction.OPEN_JLINK_DEVICE,
        `${jlinkObFirmwareVersion}`
    );
    logger.info('Device family', deviceFamily);
    usageData.sendUsageData(EventAction.OPEN_JLINK_DEVICE, `${deviceFamily}`);
    logger.info('Device version', deviceVersion);
    usageData.sendUsageData(EventAction.OPEN_JLINK_DEVICE, `${deviceVersion}`);
    logger.info('Board version', boardVersion);
    usageData.sendUsageData(EventAction.OPEN_JLINK_DEVICE, `${boardVersion}`);
};

/**
 * Get device memory map by calling nrf-device-lib and reading the entire non-volatile memory
 * const getDeviceMemMap = async (serialNumber, coreInfo, fullRead = true) => {
 *
 * @param {number} deviceId the Id of the device
 * @param {CoreDefinition} coreInfo the information of the core
 * @returns {void}
 */
const getDeviceMemMap = async (deviceId: number, coreInfo: CoreDefinition) => {
    return (await new Promise(resolve => {
        logger.info(`Reading memory for ${coreInfo.name}`);
        nrfdl.firmwareRead(
            getDeviceLibContext(),
            deviceId,
            'NRFDL_FW_BUFFER',
            'NRFDL_FW_INTEL_HEX',
            result => {
                const errorMessage = (result as NrfdlError).message;
                if (errorMessage) {
                    usageData.sendErrorReport(
                        `Failed to get device memory map: ${errorMessage}`
                    );
                    return;
                }

                let memMap = MemoryMap.fromHex(
                    (result as FirmwareReadResult).data
                );
                const paddedArray = memMap.slicePad(
                    0,
                    coreInfo.romBaseAddr + coreInfo.romSize
                );
                memMap = MemoryMap.fromPaddedUint8Array(paddedArray);
                resolve(memMap);
            },
            () => {},
            null,
            null,
            coreInfo.name === 'NRFDL_DEVICE_CORE_NETWORK'
                ? 'NRFDL_DEVICE_CORE_NETWORK'
                : 'NRFDL_DEVICE_CORE_APPLICATION'
        );
    })) as MemoryMap;
};

/**
 * Check if the files can be written to the target device
 * The typical use case is having some HEX files that use the UICR, and a DevKit
 * that doesn't allow erasing the UICR page(s). Also, the (rare) cases where the
 * nRF SoC has readback protection enabled (and the loaded HEX files write the
 * readback-protected region).
 * In all those cases, this function will return false, and the user should not be
 * able to press the "program" button.
 * There are also instances where the UICR can be erased and overwritten, but
 * unfortunately the casuistics are just too complex.
 *
 * @returns {void}
 */
export const canWrite =
    () => (dispatch: TDispatch, getState: () => RootState) => {
        // TODO: get the UICR address from the target definition. This value
        // works for nRF51s and nRF52s, but other targets might use a different one!!!
        const appState = getState().app;
        const { isErased, isMemLoaded } = appState.target;
        const { isMcuboot } = appState.mcuboot;
        const { memMaps: fileMemMaps, mcubootFilePath } = appState.file;

        // If MCU is enabled and MCU firmware is detected
        if (isMcuboot && mcubootFilePath) {
            dispatch(targetWritableKnown(true));
            return;
        }

        // If the device has been erased or the memory has been loaded and firmware is selected
        if ((!isErased && !isMemLoaded) || !fileMemMaps.length) {
            dispatch(targetWritableKnown(false));
            return;
        }
        dispatch(targetWritableKnown(true));
    };

// To fix: Update memMap type. Uint8Array or MemoryMap?
const updateTargetRegions =
    (memMap: Uint8Array, deviceInfo: DeviceDefinition) =>
    (dispatch: TDispatch) => {
        const memMaps: MemoryBlocks = [['', memMap]];
        const regions = getTargetRegions(memMaps, deviceInfo);

        dispatch(targetRegionsKnown(regions));
        dispatch(updateFileAppRegions());
    };

/**
 * Read device flash memory
 * @returns {void}
 */
export const read =
    () => async (dispatch: TDispatch, getState: () => RootState) => {
        dispatch(loadingStart());
        const { device: inputDevice, deviceInfo: inputDeviceInfo } =
            getState().app.target;
        const device = inputDevice as Device;
        const deviceInfo = inputDeviceInfo as DeviceDefinition;

        // Read from the device
        if (
            deviceInfo.cores.find(
                c => c.protectionStatus !== 'NRFDL_PROTECTION_STATUS_NONE'
            )
        ) {
            logger.info(
                'Skipped reading, since at least one core has app readback protection'
            );
        } else {
            let memMap;
            let mergedMemMap;
            try {
                memMap = await sequence(
                    getDeviceMemMap,
                    [],
                    deviceInfo.cores.map(c => [device.id, c, true])
                );
                mergedMemMap = MemoryMap.flattenOverlaps(
                    MemoryMap.overlapMemoryMaps(
                        memMap.filter(m => m).map(m => ['', m])
                    )
                );
            } catch (error) {
                throw Error(`getDeviceMemMap: ${error}`);
            }
            dispatch(
                targetContentsKnown({
                    targetMemMap: mergedMemMap,
                    isMemLoaded: true,
                })
            );
            dispatch(updateTargetRegions(mergedMemMap, deviceInfo));
        }

        dispatch(updateTargetWritable());
        dispatch(loadingEnd());
    };

/**
 * Recover one core
 * @param {number} deviceId the Id of the device
 * @param {CoreDefinition} coreInfo the information of each core
 * @returns {void}
 */
export const recoverOneCore =
    (deviceId: number, coreInfo: CoreDefinition) =>
    async (dispatch: TDispatch) => {
        dispatch(erasingStart());
        logger.info(`Recovering device: core ${coreInfo.name}`);

        try {
            await nrfdl.firmwareErase(
                getDeviceLibContext(),
                deviceId,
                coreInfo.name === 'NRFDL_DEVICE_CORE_NETWORK'
                    ? 'NRFDL_DEVICE_CORE_NETWORK'
                    : 'NRFDL_DEVICE_CORE_APPLICATION'
            );
            return;
        } catch (e) {
            logger.error(e);
        }
    };

/**
 * Recover all cores one by one
 *
 * @returns {void}
 */
export const recover =
    () => async (dispatch: TDispatch, getState: () => RootState) => {
        const { device: inputDevice, deviceInfo: inputDeviceInfo } =
            getState().app.target;
        const { id: deviceId } = inputDevice as Device;
        const { cores } = inputDeviceInfo as DeviceDefinition;
        const results: unknown[] = [];

        const argsArray = cores.map((c: CoreDefinition) => [deviceId, c]);
        await sequence(
            (...args) => {
                return dispatch(recoverOneCore(...args));
            },
            results,
            argsArray
        );

        dispatch(erasingEnd());
        logger.info('Device recovery completed');

        const { autoRead } = getState().app.settings;
        if (autoRead) read();
    };

// Sends a HEX string to jprog.program()
const writeHex = async (
    serialNumber: string,
    coreInfo: CoreDefinition,
    hexFileString: string
) => {
    logger.info(
        'Writing hex file with @nordicsemiconductor/nrf-device-lib-js.'
    );

    const { id: deviceId } = await getDeviceFromNrfdl(
        formatSerialNumber(serialNumber)
    );

    nrfdl.firmwareProgram(
        getDeviceLibContext(),
        deviceId,
        'NRFDL_FW_BUFFER',
        'NRFDL_FW_INTEL_HEX',
        Buffer.from(hexFileString, 'utf8'),
        (err: Error) => {
            if (err)
                logger.error(`Device programming failed with error: ${err}`);
            logger.info('Device programming completed.');
        },
        ({ progressJson: progress }: nrfdl.Progress) => {
            const status = `${progress.message.replace('.', ':')} ${
                progress.progress_percentage
            }%`;
            logger.info(status);
        },
        null,
        coreInfo.name === 'Network'
            ? 'NRFDL_DEVICE_CORE_NETWORK'
            : 'NRFDL_DEVICE_CORE_APPLICATION'
    );
};

export const writeOneCore =
    (core: CoreDefinition) =>
    async (dispatch: TDispatch, getState: () => RootState) => {
        logger.info(`Writing procedure starts for core${core.coreNumber}`);
        dispatch(writingStart());
        const {
            target: { serialNumber },
            file: { memMaps },
        } = getState().app;
        const { pageSize } = core;
        const serialNumberWithCore = `${parseInt(serialNumber as string, 10)}:${
            core.coreNumber
        }`;

        if (!serialNumberWithCore || !pageSize) {
            logger.error('Select a device before writing');
            return undefined;
        }

        // Parse input files and filter program regions with core start address and size
        const overlaps = MemoryMap.overlapMemoryMaps(memMaps);
        overlaps.forEach((overlap, key) => {
            const overlapStartAddr = key;
            const overlapSize = overlap[0][1].length;

            const isInCore =
                overlapStartAddr >= core.romBaseAddr &&
                overlapStartAddr + overlapSize <=
                    core.romBaseAddr + core.romSize;
            const isUicr =
                overlapStartAddr >= core.uicrBaseAddr &&
                overlapStartAddr + overlapSize <=
                    core.uicrBaseAddr + core.pageSize;
            if (!isInCore && !isUicr) {
                overlaps.delete(key);
            }
        });
        if (overlaps.size <= 0) {
            return undefined;
        }
        const programRegions =
            MemoryMap.flattenOverlaps(overlaps).paginate(pageSize);

        await writeHex(
            serialNumberWithCore,
            core,
            programRegions.asHexString()
        );

        return undefined;
    };

// Does some sanity checks, joins the loaded HEX files, flattens overlaps,
// paginates the result to fit flash pages, and calls writeHex()
export const write =
    () => async (dispatch: TDispatch, getState: () => RootState) => {
        const {
            deviceInfo: { cores },
        } = getState().app.target;
        const results: unknown[] = [];
        const argsArray = cores.map(c => [c]);
        return sequence(
            (...args) => dispatch(writeOneCore(...args)),
            results,
            argsArray
        ).then(async () => {
            await dispatch(openDevice());
            dispatch(writingEnd());
            dispatch(updateTargetWritable());
        });
    };

// Erase all on device and write file to it.
export const recoverAndWrite = () => (dispatch: TDispatch) =>
    dispatch(recover(true)).then(() => dispatch(write()));

// Save the content from the device memory as hex file.
export const saveAsFile = () => (getState: () => RootState) => {
    const { memMap, deviceInfo } = getState().app.target;
    const maxAddress = Math.max(
        ...deviceInfo.cores.map(c => c.romBaseAddr + c.romSize)
    );

    const options = {
        title: 'Save memory as file',
        defaultPath: `nRF_Connect_Programmer_${Date.now()}.hex`,
    };

    const save = ({ filePath }: Electron.SaveDialogReturnValue) => {
        if (filePath) {
            fs.writeFile(
                filePath,
                memMap.slice(0, maxAddress).asHexString(),
                err => {
                    if (err) {
                        logger.error(
                            `Error when saving file: ${err.message || err}`
                        );
                    }
                    logger.info(`File is successfully saved at ${filePath}`);
                }
            );
        }
    };
    remote.dialog.showSaveDialog(options).then(save);
};
