// this is a milestone for the project, the client can send data to the server and receive the response.
// also the client can reconnect to the server if the connection is lost.
// there is a web server running on the port 65001, you can access the web page by visiting http://127.0.0.1:65001

/*导入模块 开始*/
const path = require('path');
const net = require('net');
const { performance } = require('perf_hooks');
const fs = require('fs');

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const ModbusRTU = require('modbus-serial');
/*导入模块 结束*/

/*类定义 开始*/

/*
* ModbusClient 类，用于管理 ModbusRTU 实例和 Modbus 通讯
* client: ModbusRTU 实例
* address: Modbus 通讯地址
* readDiscreteInputs: 读取离散输入
* readCoils: 读取多个线圈
* writeCoils: 写入多个线圈
* readHoldingRegisters: 读取单个或多个保持寄存器
* writeRegisters: 写入单个或多个寄存器
*/
class ModbusClient {
    constructor(client, address) {
        this.client = client; // 共享 ModbusRTU 实例
        this.address = address;
    }

    async readDiscreteInputs(quantity = 8, addr = 0x0800) {
        try {
            this.client.setID(this.address); // 切换到当前 PLC
            const data = await this.client.readDiscreteInputs(addr, quantity);
            console.log(`PLC ${this.address} Inputs:`, data.data);
            return data.data;
        } catch (err) {
            console.error(`Error reading discrete inputs from PLC ${this.address}:`, err);
            throw err;
        }
    }

    async readCoils(quantity = 16, addr = 0x095e) {    //M350 = 0x095e 默认读M350开始的16个
        try {
            this.client.setID(this.address); // 切换到当前 PLC
            const data = await this.client.readCoils(addr, quantity);
            //console.log(`PLC ${this.address} Coils:`, data.data);
            return data.data;
        } catch (err) {
            console.error(`Error reading coils from PLC ${this.address}:`, err);
            throw err;
        }
    }

    async writeCoils(values, addr = 0x092c) {         //M300 = 0x092c 默认写M300开始的16个 
        try {
            this.client.setID(this.address); // 切换到当前 PLC
            await this.client.writeCoils(addr, values);
            //console.log(`成功写入线圈到 PLC ${this.address}`);
        } catch (err) {
            console.error(`写入线圈失败（PLC ${this.address}）:`, err);
            throw err;
        }
    }

    async readHoldingRegisters(addr, len) {
        try {
            this.client.setID(this.address); // 切换到当前 PLC
            const data = await this.client.readHoldingRegisters(addr, len);
            //console.log(`PLC ${this.address} Holding Registers (addr: ${addr}, len: ${len}):`, data.data);
            return data.data;
        } catch (err) {
            console.error(`Error reading holding registers from PLC ${this.address}:`, err);
            throw err;
        }
    }

    async writeRegisters(addr, valueAry) {
        try {
            this.client.setID(this.address); // 切换到当前 PLC
            await this.client.writeRegisters(addr, valueAry); // 使用 writeRegisters
            //console.log(`Successfully wrote registers to PLC ${this.address} (addr: ${addr}, values:`, valueAry, ")");
        } catch (err) {
            console.error(`Error writing registers to PLC ${this.address}:`, err);
            throw err;
        }
    }
}

//eth to stm32 
/**
* TCP 客户端管理类，用于连接、发送数据、接收响应及处理重连逻辑
*/
class Clients {
    /**
     * 构造函数，初始化客户端参数和状态
     * @param {string} ip - 目标服务器IP地址 
     * @param {number} port - 目标服务器端口号
     * @param {number} [reconnectDelay=1000] - 重连延迟时间(毫秒)
     * @param {number} [timeout=5] - 响应超时时间(毫秒)
     */
    constructor(ip, port, reconnectDelay = 1000, timeout = 5) {
        // 连接参数配置
        this.ip = ip;             // 目标IP地址
        this.port = port;         // 目标端口号
        this.reconnectDelay = reconnectDelay; // 重连延迟
        this.timeout = timeout;   // 超时时间

        // 数据缓冲区配置
        this.sendBuffer = Buffer.alloc(64, 0);  // 发送缓冲区(64字节)
        this.recvBuffer = Buffer.alloc(64, 0);  // 接收缓冲区(64字节)
        this.sendLength = 0;      // 实际发送数据长度
        this.recvLength = 0;      // 实际接收数据长度

        // 连接状态管理
        this.client = null;       // TCP客户端实例
        this.connected = false;   // 是否已连接
        this.connecting = false;  // 是否正在连接
        this.hasError = false;    // 是否发生错误
        this.closed = true;       // 连接是否已关闭
        this.ended = true;        // 连接是否已结束
        this.error = null;        // 错误对象
        this.isUpdating = false;  // 是否正在更新缓冲区
        this.recvTimestamp = 0;   // 最后接收时间戳
        this.sendTimestamp = 0;   // 最后发送时间戳
        this.dataReceived = false;// 是否接收到数据

        // 初始化连接
        this.initClient();
    }

    /**
     * 初始化TCP客户端连接
     */
    initClient() {
        // 如果正在连接或已连接则直接返回
        if (this.connecting || this.connected) return;

        this.connecting = true;  // 标记为连接中
        this.client = new net.Socket();  // 创建新的Socket实例

        // 连接成功回调
        this.client.connect(this.port, this.ip, () => {
            console.log(`Connected to ${this.ip}:${this.port}`);
            this.client.setNoDelay(true);  // 禁用Nagle算法
            this.updateConnectionStatus({
                connecting: false,
                hasError: false,
                closed: false,
                ended: false,
                connected: true,
                dataReceived: false,
                error: null
            });
        });

        // 错误处理
        this.client.on('error', (err) => {
            this.updateConnectionStatus({
                connected: false,
                connecting: false,
                hasError: true,
                error: err
            });
            console.error(`Connection error: ${err.message}`);
        });

        // 连接关闭处理
        this.client.on('close', () => {
            this.updateConnectionStatus({
                connected: false,
                connecting: false,
                closed: true
            });
            console.log(`Connection closed: ${this.ip}:${this.port}`);
        });

        // 连接结束处理
        this.client.on('end', () => {
            this.ended = true;
            console.log(`Connection ended: ${this.ip}:${this.port}`);
        });
    }

    /**
   * 清理连接并尝试重连
   */
    async cleanupAndReconnect() {

        // 防止重复调用重连逻辑
        if (this.connecting) return;
        this.connecting = true;

        // 如果连接已关闭则直接返回

        if (this.client) {
            this.client?.destroy();  // 销毁现有连接
            this.client = null;
        }

        // 重置连接状态
        this.updateConnectionStatus({
            connected: false,
            connecting: false,
            hasError: false,
            closed: true,
            ended: true
        });

        console.log(`Reconnecting in ${this.reconnectDelay}ms...`);

        // 等待重连延迟
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));

        // 重新初始化连接
        this.initClient();

        // 等待连接稳定
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
    }


    getConnectionStatus() {
        return {
            connected: this.connected,
            connecting: this.connecting,
            hasError: this.hasError,
            closed: this.closed,
            ended: this.ended,
            error: this.error,
            //semaphore: this.semaphore,
            dataReceived: this.dataReceived
        };
    }

    /**
     * Refreshes the buffer by sending data to the client and waiting for a response.
     * 
     * @returns {Promise<void>} A promise that resolves when the data is successfully sent and a response is received.
     * @throws {Error} If data update is in progress, not connected, or if there is a timeout or send failure.
     * 
     * @async
     * @method
     */
    // 发送数据并等待响应
    // 核心逻辑：
    // 检查 isUpdating：锁，在updateSendBuffer执行的时候，为了防止此函数同时异步执行冲乱缓冲数据。
    //                  本函数用await修饰后在同步函数updateSendBuffer完成之后立即执行，
    //                  所以通常情况下，isUpdating 为 false，可以发送数据。
    // 检查 connected： 连接状态，如果未连接，则尝试重新连接。通常initClient会返回错误信息。
    //                  cleanupAndReconnect产生的err要如何出发测试？暂时不懂。
    // dataReceived：   锁，接收数据期间接收缓存不应该被访问。
    // timeoutId：      由异步回调onData复位，如果超时，会触发cleanupAndReconnect。
    // onData：         数据接收回调，接收到数据后，清除超时定时器，解绑监听器，设置接收标志。
    // 绑定数据事件：   以上条件都准备好之后才绑定数据事件并发送数据，保证接收的回包是对应的请求。
    //                  write产生的err要如何出发测试？暂时不懂。 
    //
    // 函数行为：       通过await修饰，确保sendBuf按照顺序执行，不会同时发送多个请求，
    //                  cleanupAndReconnect期间，await会等待连接完成后继续执行。
    //                  如果数据正在更新，会抛出错误"Data lock active"。
    //                  如果未连接，会抛出错误"Not connected"。
    //                  如果 client.write 失败，会抛出具体的错误信息。
    //                  如果超时，会触发cleanupAndReconnect，抛出错误"Response timeout, reconnected"。
    //                  如果cleanupAndReconnect失败，会抛出错误"Reconnect failed: ${err.message}"。
    //                  如果其他错误，会抛出错误"Error: ${err.message}"。
    //                  如果发送成功，不会返回数据，只会返回"OK"。
    //                  如果发送失败，不会返回数据，只会抛出错误。
    //                  接收到数据，会设置dataReceived为true，不会返回数据，只会返回"OK"。 
    //                  如果接收失败，会抛出错误"Error: ${err.message}"。
    //
    // 逻辑控制：       通过Promise控制逻辑，确保发送完成后再退出。

    // 非阻塞特性：     通过await修饰，确保sendBuf按照顺序执行，不会同时发送多个请求。      
    async refreshBuf() {

        return new Promise(async (resolve, reject) => {
            // 检查数据更新锁
            if (this.isUpdating) {
                console.error("Data is being updated, cannot send data. check call sequence.");
                return reject(new Error("Data update in progress"));
            }

            // 判断是否连接
            if (!this.connected) {
                console.error("Cannot send data, not connected, try to connecting...");

                // 封装 cleanupAndReconnect 为 Promise 并等待完成
                this.cleanupAndReconnect().then(() => {
                    // 连接完成后继续
                    resolve();
                }).catch((err) => {
                    reject(new Error(`Reconnect failed: ${err.message}`));
                });

                return; // 直接返回，不继续执行
            }

            // 重置接收数据标志
            this.client.dataReceived = false;


            // 设置超时定时器
            const timeoutId = setTimeout(() => {
                console.warn("Response timeout, reconnecting...");

                // 封装 cleanupAndReconnect 为 Promise 并等待完成
                this.cleanupAndReconnect().then(() => {
                    reject(new Error("Response timeout, reconnected"));
                }).catch((err) => {
                    reject(new Error(`Reconnect failed: ${err.message}`));
                });
            }, this.timeout);

            // 监听数据事件
            const onData = (data) => {
                this.recvTimestamp = performance.now();; // 设置接收时间戳
                clearTimeout(timeoutId); // 清除超时定时器
                this.client.off('data', onData); // 解绑监听器

                this.recvLength = Math.min(data.length, this.recvBuffer.length); // 设置实际接收长度
                data.copy(this.recvBuffer, 0, 0, this.recvLength); // 数据复制到 recvBuffer
                this.dataReceived = true; // 设置接收标志
                console.log(`[INFO] Received from ${this.ip}:${this.port}: ${data.toString('hex')}`);
                console.log(`loop time: ${(this.recvTimestamp - this.sendTimestamp).toFixed(3)}ms`);
                resolve(); // **仅退出，不返回数据**
            };

            // 绑定数据事件
            this.client.on('data', onData);

            // 立即发送数据
            this.sendTimestamp = performance.now();; // 设置发送时间戳
            this.client.write(this.sendBuffer.subarray(0, this.sendLength), (err) => {
                if (err) {
                    clearTimeout(timeoutId); // 清除超时定时器
                    this.client.off('data', onData); // 解绑监听器
                    console.error(`[ERROR] Send failed: ${this.ip}:${this.port}`);
                    reject(err);
                } else {
                    console.log(`[INFO] Data sent to ${this.ip}:${this.port}`);
                }
            });
        });
    }


    /**
     * Updates the send buffer with the provided data.
     *
     * @param {Buffer} data - The data to copy into the send buffer.
     * @param {number} length - The length of the data to copy.
     * @returns {string} - Returns "OK" if the buffer was updated successfully, otherwise returns "ERROR".
     */
    updateSendBuffer(data, length) {
        if (!data || length <= 0 || length > this.sendBuffer.length) {
            console.error(`[ERROR] Invalid data length for ${this.ip}:${this.port}`);
            return "ERROR";
        }

        this.isUpdating = true; // 标记正在更新缓冲区

        try {
            this.sendBuffer.fill(0);
            data.copy(this.sendBuffer, 0, 0, length);
            this.sendLength = length;
            return "OK";
        } catch (err) {
            console.error(`[ERROR] Buffer update failed: ${err.message}`);
            return "ERROR";
        } finally {
            this.isUpdating = false; // 更新完成，清除标志
        }
    }

    /**
    * 更新连接状态（内部方法）
    * @param {Object} updates - 需要更新的状态字段 
    */
    updateConnectionStatus(updates) {
        Object.assign(this, updates);
    }

}

/*类定义 结束*/


/*全局定义 开始*/

//网页服务器和端口
const app = express();
const PORT = 65001;

// //系统配置文件路径定义
// const CONFIG_DIR = path.join(__dirname, '../config');
// const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const hmi_process_params = {
    inc_thickness_pressStartTime: null,
    inc_thickness_onTimeout: null,
    dec_thickness_pressStartTime: null,
    dec_thickness_onTimeout: null,
    //系统配置文件路径定义
    CONFIG_DIR: path.join(__dirname, '../config'),
    CONFIG_PATH: path.join(__dirname, '../config/config.json')
};

// 1. 定义 recvFromHMI_json 对象, 用于接收 HMI 页面数据并更新服务器状态
// loadOrCreateConfig会根据config初始化，相当于读取之前的设定。如果没有config，会使用initData_json初始化。
// 另外还包含了一些全局变量，用于函数之间传递数据。
let recvFromHMI_json = {
    inc_conveyor_speed_mousedown: false,
    dec_conveyor_speed_mousedown: false,
    inc_thickness_mousedown: false,
    dec_thickness_mousedown: false,
    en_conveyor_vacuum: false,
    en_brush_unit: false,
    en_cal_drum: false,
    en_wide_belt: false,
    en_cross: false,
};

// 2. 定义 sent2Hmi_json 对象, 用于向 HMI 页面发送服务器状态
//loadOrCreateConfig会根据config初始化，相当于读取之前的设定。如果没有config，会使用initData_json初始化。
let sent2Hmi_json = {
    conveyor_speed: undefined,
    thickness: undefined,
    inc_thickness_on: false,
    dec_thickness_on: false,
    en_conveyor_vacuum: false,
    en_brush_unit: false,
    en_cal_drum: false,
    en_wide_belt: false,
    en_cross: false,
    head1_current: 50,
    head1_tracking_status: 0,
    head1_tracking_valve_on: false,
    head2_current: 0,
    head3_current: 0,
    machine_status: "STOPPED/READY"
};

// 服务器端 JSON 数据
// loadOrCreateConfig会根据config初始化，相当于读取之前的设定。
// config.json应该始终保存这机器当前的运行数据，以便下次启动时恢复。
// 如果没有config，会反过来使用initData_json中的数据创建一个config.json到本地磁盘。
//      这就相当于可以强制初始化config.json，但是这样会丢失之前的数据。
//      可以手动设定conveyor_speed:,thickness:, 或者其他成员的值然后重启服务器，这样config.json就会被强制初始化。
//      之后必须将conveyor_speed:,thickness:,设定为undefined，其他值需要设定为false, 以增加鲁棒性。
let initData_json = {
    conveyor_speed: undefined,
    thickness: undefined,
    en_conveyor_vacuum: false,
    en_brush_unit: false,
    en_cal_drum: true,
    en_wide_belt: false,
    en_cross: false,
    //machine_status: "STOPPED/READY"
    //machine_status: "RUNNING"
};

// 创建 tcp Clients 实例
const client1 = new Clients('192.168.1.123', 60001);

/* modbus RTU 接口配置
* serial_port_addr: 串口地址
* serial_port_options: 串口配置
* modbusRTU: ModbusRTU 实例
*/
const modbusInterface = {
    serial_port_addr: '/dev/ttyUSB0',
    serial_port_options: { baudRate: 115200, dataBits: 8, parity: 'even', stopBits: 1 },
    modbusRTU: new ModbusRTU()
};

// plc站点管理对象
// 每个站点包含 stationId： plc通讯用的modbus站号同时也是plc编程软件的通讯站号， 
//              client：    modbusClient对象，通过成员函数和plc通讯，
//              sever_to_plcxx： 服务器到plc的数据
//              plcx x_to_sever： plc到服务器的数据
const plcManager = {
    plc11: {
        stationId: 11,
        client: null,

        sever_to_plc11: {
            run_stop_from_sever_c: false, //m300
            suction_en: true, //m301
            brush_en: true, //m302
            conveyor_en: true, //m303       

            exhauseDeviceOn_c: false, //m304
            height_up_c: false, //m305  
            height_down_c: false, //m306
            height_en: true, //m307

            m308_: false,
            m309_: false,
            m310_: false,
            m311_: false,

            m312_: false,
            reset_c: false,         //m313  
            init_enable: false,          //m314
            user_WDT: true,          //m315

            thickness: 0,           //d102, d103 dword
            conveyor_speed: 0.0,    //d101
            //user_WDT: 0,            //T10
        },

        plc11_to_sever: {
            start_plc_input: false, //m350
            estop_plc_input: false, //m351
            door_infeed_safety_plc_input: false, //m352
            stop_from_plc: false, //m353

            suction_running_f: false,     //m354
            brush_running_f: false,       //m355
            conveyor_running_f: false,    //m356
            m357_: false,

            m358_: false,
            m359_: false,
            m360_: false,
            m361_: false,

            m362_: false,
            phase_rotation_ok_plc_input: false,       //m363
            reset_ok_f: false,       //m364
            init_done: false,   //m365

            thickness: 0,       //d102, d103 dword
            conveyor_speed: 0.0,//d101
            //user_WDT: 0,        //T10
        }
    },
    plc12: {
        stationId: 12,
        client: null,
        sever_to_plc12: {
            run_stop_from_sever_c: false,      //m300
            head1_en: true,    //m301
            safety_ok: false,   //m302
            m303_: false,

            m304_: false,
            m305_: false,
            m306_: false,
            m307_: false,

            m308_: false,
            m309_: false,
            m310_: false,
            m311_: false,

            m312_: false,
            reset_c: false,        //m313
            init_enable: true,        //m314
            chearUserWDT: true,         //m315
        },

        plc12_to_sever: {
            q1b_trip: false,    //m350
            thermo_ol: false,   //m351
            head1_running_f: false, //m352
            m353_: false,

            m354_: false,
            m355_: false,
            m356_: false,
            m357_: false,

            m358_: false,
            m359_: false,
            m360_: false,
            m361_: false,

            m362_: false,
            fault_latch: false, //m363
            reset_ok_f: false, //m364
            init_done: false,   //m365
        }
    }
};

/*全局定义 结束*/

/*自定义函数 开始*/

/****同步加载或创建 JSON 配置**
 * Loads the configuration from `config.json` if it exists, 
 * otherwise creates the file with default data（initData_json). 
 *      by delete the `config.json` and set initData_json manualy 
 *      then run this func can create the config.json with the init machine settings
 *      after done this, all members of the initData_json have to be reset to undefined or false
 * 
 * The configuration always initialize `sent2Hmi_json` and `recvFromHMI_json` with initData_json.
 *
 * @throws Will terminate the process if reading or creating `config.json` fails.
 */
function loadOrCreateConfig(plcManager) {
    try {
        // **先定义配置目录**
        const CONFIG_DIR = path.join(__dirname, '../config');

        // **再基于 CONFIG_DIR 定义 config.json 的路径**
        const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

        if (fs.existsSync(CONFIG_PATH)) {
            console.log("✅ 检测到 `config.json`，开始加载...");
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            initData_json = JSON.parse(data);

            initializeData(sent2Hmi_json, initData_json);
            initializeData(recvFromHMI_json, initData_json);
            initializeData(plcManager.plc11.plc11_to_sever, initData_json);
            initializeData(plcManager.plc11.sever_to_plc11, initData_json);

            console.log("✅ `config.json` 加载成功:", initData_json);
            console.log("sent2Hmi_json:", sent2Hmi_json);
            console.log("recvFromHMI_json:", recvFromHMI_json);
            console.log("plc11_to_sever:", plcManager.plc11.plc11_to_sever);
            console.log("sever_to_plc11:", plcManager.plc11.sever_to_plc11);

            // 如果配置文件不存在，使用initData_json则创建并初始化文件，同时初始化sent2Hmi_json 和 recvFromHMI_json
        } else {
            console.log("⚠️ `config.json` 不存在，创建并初始化...");
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(initData_json, null, 4), 'utf8');
            console.log("✅ `config.json` 创建成功，使用默认数据", initData_json);

            //初始化所有json
            initializeData(sent2Hmi_json, initData_json);
            initializeData(recvFromHMI_json, initData_json);
            //initializeData(plcManager.plc11.plc11_to_sever, initData_json);
            initializeData(plcManager.plc11.sever_to_plc11, initData_json);

            console.log("plc11_to_sever:", plcManager.plc11.plc11_to_sever);
            console.log("sever_to_plc11:", plcManager.plc11.sever_to_plc11);
            console.log("sent2Hmi_json:", sent2Hmi_json);
            console.log("recvFromHMI_json:", recvFromHMI_json);
        }
    } catch (error) {
        console.error("❌ 读取或创建 `config.json` 失败:", error);
        process.exit(1); // 终止程序
    }
}

// 使用循环 赋初值
function initializeData(targetJson, sourceJson) {
    for (const key in sourceJson) {
        if (targetJson.hasOwnProperty(key)) {
            targetJson[key] = sourceJson[key];
        }
    }
}

/**
 * 初始化 plc对象的modbus RTU通讯接口实例和站号
 *
 * @async
 * @function initializeModbusPLC
 * @param {object} _modbusInterface - Modbus 接口配置对象
 * @param {object} plc_instances - 具体的plc实例，包含client和stationId，通过plcmanager.xxxx传入
 * @param {number} [timeout=200] - 连接超时时间（毫秒）
 * @returns {Promise<void>} - 返回一个 Promise 对象，表示初始化完成
 * @throws {Error} - 如果连接超时或创建 ModbusClient 失败
 *  调用函数前，需要先初始化modbusInterface，然后传入plcManager.xxxx。
 *  创建一个modbusClient实例，然后赋值给plcManager.xxxx.client，
 *      具体内容：构造函数会传入modbusRTU对象，因此plc_instances就知道如何通过pc的modbus接口和plc通讯。
 *                还传入plc站号，用于区分不同的plc。         
 */
async function initializePLCmodbus(_modbusInterface, plc_instances, timeout = 200) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error("Modbus PLC 连接超时"));
        }, timeout);

        try {
            // Create ModbusClient instances for each PLC station
            plc_instances.client = new ModbusClient(_modbusInterface.modbusRTU, plc_instances.stationId);
            clearTimeout(timeoutId); // Clear the timeout once the ModbusClient is created
            console.log(`PLC ${plc_instances.stationId} modbus通讯建立成功`);
            resolve(); // Resolve the promise indicating successful initialization
        } catch (error) { // Handle the error if creating ModbusClient fails
            console.error(`PLC ${plc_instances.stationId} modbus通讯建立失败:`, error);
            reject(error); // Reject the promise to signal failure
        }
    });
}

/**
 * 初始化 pc端 Modbus RTU 接口
 * @async
 * @function initializeModbusInterface
 * @param {object} _modbusInterface - Modbus 接口配置对象
 * @param {number} [timeout=1000] - 连接超时时间（毫秒）
 * @returns {Promise<void>} - 返回一个 Promise 对象，表示初始化完成
 * @throws {Error} - 如果 Modbus 连接超时或连接失败
 */
async function initializeModbusInterface(_modbusInterface, timeout = 200) {
    return new Promise((resolve, reject) => {
        // Set a timeout to reject the promise if the connection takes too long
        const timeoutId = setTimeout(() => {
            reject(new Error("Modbus 接口连接超时"));
        }, timeout);

        // Attempt to connect to the Modbus RTU interface
        _modbusInterface.modbusRTU.connectRTUBuffered(
            _modbusInterface.serial_port_addr,
            _modbusInterface.serial_port_options,
            (err) => {
                // Clear the timeout once the connection attempt is complete
                clearTimeout(timeoutId);

                if (err) {
                    // Reject the promise if there was an error during connection
                    reject(err);
                    return;
                }

                console.log("Modbus 接口初始化成功");
                // Connection successful, resolve the promise
                resolve();
            }
        );
    });
}

/**
 * MODBUS/ PLC 初始化
 *
 * @async
 * @function modbusPLCsInit
 * @param {object} modbusInterface - Modbus 接口配置对象
 * @param {object} plcManager - PLC 管理对象 (包含 plc11 和 plc12)
 * @returns {Promise<void>} - 返回一个 Promise 对象，表示初始化流程完成
 * @throws {Error} - 如果初始化过程中的任何步骤失败
 */
async function modbusPLCsInit(modbusInterface, plcManager) {
    try {
        await initializeModbusInterface(modbusInterface);
        await initializePLCmodbus(modbusInterface, plcManager.plc11);
        await initializePLCmodbus(modbusInterface, plcManager.plc12);
        
        //plc11 初始状态设置
        // 提取 plc11.sever_to_plc11 中的线圈值
        // 错误：以下对plc的读写好像并不需要，可能是之前调试留下的代码
        const coilValues = [
            plcManager.plc11.sever_to_plc11.stop_c,
            plcManager.plc11.sever_to_plc11.suction_start,
            plcManager.plc11.sever_to_plc11.brush_start,
            plcManager.plc11.sever_to_plc11.conveyor_start,
            plcManager.plc11.sever_to_plc11.exhauseDeviceOn_c,
            plcManager.plc11.sever_to_plc11.height_up_c,
            plcManager.plc11.sever_to_plc11.height_down_c,
            plcManager.plc11.sever_to_plc11.height_en,
            plcManager.plc11.sever_to_plc11.m308_,
            plcManager.plc11.sever_to_plc11.m309_,
            plcManager.plc11.sever_to_plc11.m310_,
            plcManager.plc11.sever_to_plc11.m311_,
            plcManager.plc11.sever_to_plc11.m312_,
            plcManager.plc11.sever_to_plc11.m313_,
            plcManager.plc11.sever_to_plc11.m314_,
            plcManager.plc11.sever_to_plc11.m315_,
        ];
        // 写入线圈到 PLC 11
        await plcManager.plc11.client.writeCoils(coilValues, 0x092c);

        // 将 thickness 和 conveyor_speed 乘以 比率
        const thicknessValue = plcManager.plc11.sever_to_plc11.thickness * 20;
        const conveyorSpeedValue = plcManager.plc11.sever_to_plc11.conveyor_speed * 100;

        await plcManager.plc11.client.writeRegisters(0x1064, [thicknessValue]);
        await plcManager.plc11.client.writeRegisters(0X1065, [conveyorSpeedValue]);

        console.log("modbus接口/plc通讯初始化成功");
    } catch (error) {
        console.error("modbus接口/plc通讯初始化失败:", error);
        // 生产环境中，可能需要更详细的错误处理和日志记录
    }
}

// 定义一个函数，用于拷贝相同元素的值, 并实时保存config.json
function hmi_process(recvData, sendData, initData, configPath) {
    let dirty = false;

    // // **先定义配置目录**
    // const CONFIG_DIR = path.join(__dirname, '../config');

    // // **再基于 CONFIG_DIR 定义 config.json 的路径**
    // const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

    if (recvData.inc_conveyor_speed_mousedown) {
        sendData.conveyor_speed = Math.min(sendData.conveyor_speed + 0.05, 7);
        sendData.conveyor_speed = parseFloat(sendData.conveyor_speed.toFixed(2));
    }
    if (recvData.dec_conveyor_speed_mousedown) {
        sendData.conveyor_speed = Math.max(sendData.conveyor_speed - 0.05, 1);
        sendData.conveyor_speed = parseFloat(sendData.conveyor_speed.toFixed(2));
    }

    sendData.inc_thickness_on = recvData.inc_thickness_mousedown && !recvData.inc_thickness_mouseup && sendData.thickness < 1000;
    sendData.dec_thickness_on = recvData.dec_thickness_mousedown && !recvData.dec_thickness_mouseup && sendData.thickness > 100;

    // 处理 recvData
    for (const key in recvData) {
        if (sendData.hasOwnProperty(key)) {
            sendData[key] = recvData[key];
        }

        if (initData.hasOwnProperty(key) && initData[key] !== recvData[key]) {
            initData[key] = recvData[key];
            dirty = true;
        }
    }

    // 处理 sendData
    for (const key in sendData) {
        if (initData.hasOwnProperty(key) && initData[key] !== sendData[key]) {
            initData[key] = sendData[key];
            dirty = true;
        }
    }

    if (dirty) {
        try {
            fs.writeFileSync(configPath, JSON.stringify(initData, null, 4), 'utf8');
            console.log('Config file updated successfully.'); // 可选：添加日志信息
        } catch (error) {
            console.error('Error writing config file:', error); // 必须：错误处理
            // 在这里可以添加其他错误处理逻辑，例如：
            // 1. 尝试备份旧的配置文件
            // 2. 发送错误通知
            // 3. 退出程序，防止数据不一致
        }
    }

    // // 遍历所有连接的客户端并发送数据
    // wss.clients.forEach(client => {
    //     if (client.readyState === WebSocket.OPEN) {
    //         client.send(JSON.stringify(sendData));
    //     } else {
    //         console.warn(`客户端 ${client.clientId} 连接不可用，无法发送数据。`);
    //         // 从连接列表中移除客户端
    //         wss.clients.delete(client);
    //         console.log(`客户端 ${client.clientId} 已被移除。`);
    //     }
    // });

    // 遍历所有 WebSocket 客户端并发送数据
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(sendData));
            } catch (error) {
                console.warn(`发送数据到客户端 ${client.clientId} 失败:`, error);
                client.terminate(); // 关闭异常客户端
            }
        } else {
            console.warn(`客户端 ${client.clientId} 连接不可用，移除。`);
            client.terminate();
        }
    });

}

// // plc11 初始化函数
// async function plc11_init(plc11, _sent2Hmi_json) {
//     try {
//         //  在loadOrCreateConfig中已经读盘初始化了plc11的数据
//         //  现在将plc11的数据写入plc11的寄存器和线圈
//         // 拆分 32 位整数（Little-Endian）
//         const lowWord = plc11.sever_to_plc11.thickness & 0xFFFF; // 获取低 16 位
//         const highWord = (plc11.sever_to_plc11.thickness >> 16) & 0xFFFF; // 获取高 16 位
//         // 发送 16 位整数到 PLC (Little-Endian)
//         await plc11.client.writeRegisters(0x1066, [lowWord, highWord]);

//         //  然后置位init_enable的线圈为true，然后写入plc11的寄存器
//         const coilValuesToWrite = [
//             plc11.sever_to_plc11.stop_c,
//             plc11.sever_to_plc11.suction_start,
//             plc11.sever_to_plc11.brush_start,
//             plc11.sever_to_plc11.conveyor_start,
//             plc11.sever_to_plc11.exhauseDeviceOn_c,
//             plc11.sever_to_plc11.height_up_c,
//             plc11.sever_to_plc11.height_down_c,
//             plc11.sever_to_plc11.height_en,
//             plc11.sever_to_plc11.m308_,
//             plc11.sever_to_plc11.m309_,
//             plc11.sever_to_plc11.m310_,
//             plc11.sever_to_plc11.m311_,
//             plc11.sever_to_plc11.m312_,
//             plc11.sever_to_plc11.m313_,
//             plc11.sever_to_plc11.init_enable = true,
//             plc11.sever_to_plc11.user_WDT,
//         ];
//         await plc11.client.writeCoils(coilValuesToWrite, 0x092c);

//         //


//         console.log("PLC 11 初始化成功");
//     } catch (error) {
//         console.error("PLC 11 初始化失败:", error);
//     }
// }

// plc11 逻辑处理函数
async function plc11_process(plc11, _sent2Hmi_json) {
    try {


        //临时对象用于存储将要写入的数据
        const coilValuesToWrite = [
            plc11.sever_to_plc11.run_stop_from_sever_c,
            plc11.sever_to_plc11.suction_en,
            plc11.sever_to_plc11.brush_en,
            plc11.sever_to_plc11.conveyor_en,
            plc11.sever_to_plc11.exhauseDeviceOn_c,
            plc11.sever_to_plc11.height_up_c,
            plc11.sever_to_plc11.height_down_c,
            plc11.sever_to_plc11.height_en,
            plc11.sever_to_plc11.m308_,
            plc11.sever_to_plc11.m309_,
            plc11.sever_to_plc11.m310_,
            plc11.sever_to_plc11.m311_,
            plc11.sever_to_plc11.m312_,
            plc11.sever_to_plc11.reset_c,
            plc11.sever_to_plc11.init_enable,
            plc11.sever_to_plc11.user_WDT,
        ];
    
        // 读取 M350 开始的 16 个线圈, 检查是否初始化完成
        const coilData = await plc11.client.readCoils(16, 0x095e);
        // 更新 plc11.plc11_to_sever 对象中的线圈值
        plc11.plc11_to_sever.start_plc_input = coilData[0];
        plc11.plc11_to_sever.estop_plc_input = coilData[1];
        plc11.plc11_to_sever.door_infeed_safety_plc_input = coilData[2];
        plc11.plc11_to_sever.stop_from_plc = coilData[3];
        plc11.plc11_to_sever.suction_running_f = coilData[4];
        plc11.plc11_to_sever.brush_running_f = coilData[5];
        plc11.plc11_to_sever.conveyor_running_f = coilData[6];
        plc11.plc11_to_sever.m357_ = coilData[7];
        plc11.plc11_to_sever.m358_ = coilData[8];
        plc11.plc11_to_sever.m359_ = coilData[9];
        plc11.plc11_to_sever.m360_ = coilData[10];
        plc11.plc11_to_sever.m361_ = coilData[11];
        plc11.plc11_to_sever.m362_ = coilData[12];
        plc11.plc11_to_sever.m363_ = coilData[13];
        plc11.plc11_to_sever.reset_ok_f = coilData[14];
        plc11.plc11_to_sever.init_done = coilData[15];
        // 调试：读取 PLC 11 数据:", plc11.plc11_to_sever);
        //console.log("成功读取 PLC 11 数据:", plc11.plc11_to_sever);

        // 初始化plc11开始
        //  在loadOrCreateConfig中已经读盘初始化了plc11的数据
        //  按照初始化完成标志plc11.plc11_to_sever.init_done来判断是否需要初始化
        if (!plc11.plc11_to_sever.init_done) {
            // 拆分 32 位整数（Little-Endian）
            const lowWord = plc11.sever_to_plc11.thickness & 0xFFFF; // 获取低 16 位
            const highWord = (plc11.sever_to_plc11.thickness >> 16) & 0xFFFF; // 获取高 16 位
            // 发送 16 位整数到 PLC (Little-Endian)
            await plc11.client.writeRegisters(0x1066, [lowWord, highWord]);

            //  然后置位init_enable的线圈为true，然后写入plc11的寄存器
            plc11.sever_to_plc11.init_enable = true;
            
            await plc11.client.writeCoils(coilValuesToWrite, 0x092c);
            //调试：写入 PLC 11 数据:", plc11.sever_to_plc11);
            //console.log("成功写入 PLC 11 数据:", plc11.sever_to_plc11);



        }

        //初始化plc11结束
        else {
            
            // 更新 PLC 11 的线圈值
            plc11.sever_to_plc11.height_up_c = _sent2Hmi_json.inc_thickness_on;
            plc11.sever_to_plc11.height_down_c = _sent2Hmi_json.dec_thickness_on;
            plc11.sever_to_plc11.conveyor_speed = _sent2Hmi_json.conveyor_speed;
            plc11.sever_to_plc11.init_enable = false;
            await plc11.client.writeCoils(coilValuesToWrite, 0x092c);

            // 更新 PLC 11 的寄存器值 (thickness 和 conveyor_speed)
            // await plc11.client.writeRegisters(0x1064, [
            //     _sent2Hmi_json.thickness * 20,
            //     _sent2Hmi_json.conveyor_speed * 155
            // ]);
            //await plc11.client.writeRegisters(0x1064, [_sent2Hmi_json.thickness * 20]);
            await plc11.client.writeRegisters(0x1065, [_sent2Hmi_json.conveyor_speed * 155]);
            //当初始化完成之后，就不断获取厚度数据
            const registerData = await plc11.client.readHoldingRegisters(0x1066, 2);
            plc11.plc11_to_sever.thickness = registerData[0] + registerData[1] * 65536;
            //更新数据到sent2Hmi_json，以便HMI显示，并且保存到config.json
            _sent2Hmi_json.thickness = plc11.plc11_to_sever.thickness;
            //为了保持数据一致性，更新plc11.sever_to_plc11.thickness的值，但是并不写入plc11
            //只有初始化的时候才读档并写入厚度数据到plc,之后只能读取plc中的厚度计数值
            //至于电源波动以及plc和pc各自的状态不一致，这个问题需要在硬件层面解决
            plc11.sever_to_plc11.thickness = plc11.plc11_to_sever.thickness;
            // //喂狗
            // await plc11.client.writeRegisters(0x0e10, [plc11.sever_to_plc11.user_WDT]);
            //调试：写入 PLC 11 数据:", plc11.sever_to_plc11);
            //console.log("成功写入 PLC 11 数据:", plc11.sever_to_plc11);
        }
    } catch (error) {
        console.error("读写 PLC 11 失败:", error);
    }
}
// // plc12 逻辑处理函数
async function plc12_process(plc12, _sent2Hmi_json) {
    try {
         //临时对象用于存储将要写入的数据
         const coilValuesToWrite = [
            plc12.sever_to_plc12.run_stop_from_sever_c,
            plc12.sever_to_plc12.head1_en,
            plc12.sever_to_plc12.safety_ok, 
            plc12.sever_to_plc12.m303_,
            plc12.sever_to_plc12.m304_,
            plc12.sever_to_plc12.m305_,
            plc12.sever_to_plc12.m306_,
            plc12.sever_to_plc12.m307_,
            plc12.sever_to_plc12.m308_,
            plc12.sever_to_plc12.m309_,
            plc12.sever_to_plc12.m310_,
            plc12.sever_to_plc12.m311_,
            plc12.sever_to_plc12.m312_,
            plc12.sever_to_plc12.reset_c,
            plc12.sever_to_plc12.init_enable,
            plc12.sever_to_plc12.chearUserWDT,
        ];

        await plc12.client.writeCoils(coilValuesToWrite, 0x092c);
            //调试：写入 PLC 11 数据:", plc11.sever_to_plc11);
            console.log("成功写入 PLC 12 数据:", plc12.sever_to_plc12);

        // 读取 M350 开始的 16 个线圈, 检查是否初始化完成
        const coilData = await plc12.client.readCoils(16, 0x095e);
        // 更新 plc12.plc12_to_sever 对象中的线圈值
        plc12.plc12_to_sever.q1b_trip = coilData[0];
        plc12.plc12_to_sever.thermo_ol = coilData[1];
        plc12.plc12_to_sever.head1_running_f = coilData[2];
        plc12.plc12_to_sever.m353_ = coilData[3];
        plc12.plc12_to_sever.m354_ = coilData[4];
        plc12.plc12_to_sever.m355_ = coilData[5];
        plc12.plc12_to_sever.m356_ = coilData[6];
        plc12.plc12_to_sever.m357_ = coilData[7];
        plc12.plc12_to_sever.m358_ = coilData[8];
        plc12.plc12_to_sever.m359_ = coilData[9];
        plc12.plc12_to_sever.m360_ = coilData[10];
        plc12.plc12_to_sever.m361_ = coilData[11];
        plc12.plc12_to_sever.m362_ = coilData[12];  
        plc12.plc12_to_sever.fault_latch = coilData[13];
        plc12.plc12_to_sever.reset_ok_f = coilData[14];
        plc12.plc12_to_sever.init_done = coilData[15];
        // 调试：读取 PLC 12 数据:", plc12.plc12_to_sever);
        //console.log("成功读取 PLC 12 数据:", plc12.plc12_to_sever);

    } catch (error) {   
        console.error("读写 PLC 12 失败:", error);
    }

}


//  主控逻辑处理函数
function control_main(hmi_data1, station1_data){
    hmi_data1.head1_tracking_valve_on = station1_data;
    //console.log('hmi_data1:', hmi_data1);

}

/*自定义函数 结束*/

/*系统初始化 开始*/

// **调用加载 JSON 配置**
loadOrCreateConfig(plcManager);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

/// **动态提供 JSON 数据作为 JS 文件**
app.get('/js/initData.js', (req, res) => {
    res.type('application/javascript');
    res.send(`let initData_json = ${JSON.stringify(initData_json)};`);
    console.log('initData_json:', initData_json);
});

// 创建 HTTP 服务器实例
const server = http.createServer(app);

// 创建 WebSocket 服务器并绑定到同一个 HTTP 服务器实例
const wss = new WebSocket.Server({ server });
let nextClientId = 1; // 自增 ID

// 启动网页服务器
server.listen(PORT, () => {
    console.log(`Server is running at http://127.0.0.1:${PORT}`);
});

// 启动 WebSocket 服务器
wss.on('connection', (ws, req) => {

    ws.clientId = nextClientId++; // 分配唯一标识符
    console.log(`Client ${ws.clientId} connected`);

    // 监听来自客户端的消息
    ws.on('message', (message) => {
        //console.log(`Received from client ${ws.clientId}: ${message}`);

        //let clientData;
        try {
            recvFromHMI_json = JSON.parse(message);
        } catch (error) {
            console.error('JSON parse error:', error);
            return;
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.clientId} disconnected`);
    });

    ws.on('error', (error) => {
        console.error(`Error from client ${ws.clientId}: ${error}`);
    });
});

modbusPLCsInit(modbusInterface, plcManager);

/*系统初始化 结束*/

/* 业务执行函数和变量 begin */

//每隔20毫秒执行一次 hmi_process 函数
setInterval(() => {
    //control_main(sent2Hmi_json, client1.recvBuffer[2]);//client1.recvBuffer[2]
    hmi_process(recvFromHMI_json, sent2Hmi_json, initData_json, hmi_process_params.CONFIG_PATH);
}, 20);

//每隔1000毫秒执行一次 hmi_process 函数
// setInterval(() => {
//     plc12_process(plcManager.plc12, sent2Hmi_json);
//     plc11_process(plcManager.plc11, sent2Hmi_json);
    
// }, 1000);



setInterval(async () => {
    try {
        
        //plc11的逻辑处理
        plcManager.plc11.sever_to_plc11.run_stop_from_sever_c = plcManager.plc11.plc11_to_sever.start_plc_input
                                                                && plcManager.plc11.plc11_to_sever.estop_plc_input && 0;
                                                                
        //await new Promise(resolve => setTimeout(resolve, 5)); // 等待 5ms
        await plc11_process(plcManager.plc11, sent2Hmi_json);

        //plc12的逻辑处理
        plcManager.plc12.sever_to_plc12.safety_ok =plcManager.plc11.plc11_to_sever.door_infeed_safety_plc_input 
                                                    && plcManager.plc11.plc11_to_sever.estop_plc_input;
                                            
        plcManager.plc12.sever_to_plc12.run_stop_from_sever_c = plcManager.plc11.sever_to_plc11.run_stop_from_sever_c;
        
        
        await plc12_process(plcManager.plc12, sent2Hmi_json);

    } catch (error) {
        console.error("PLC 处理过程出错:", error);
    }
}, 200);




/* 业务执行函数和变量 end */

// 等待客户端连接plc11_to_sever
setTimeout(async () => {
    // 按照一秒周期循环执行 updateSendBuffer 和 refreshBuf
    while (true) {
        try {
            // 更新发送缓冲区
            const updateResult = client1.updateSendBuffer(Buffer.from([0x5A]), 44);
            if (updateResult === "ERROR") {
                console.error("Failed to update send buffer.");
                continue; // 跳过本次循环
            }


            // 发送数据
            await client1.refreshBuf();

            // 显示当前连接状态
            console.log("Connection status:", client1.getConnectionStatus());

        } catch (err) {
            console.error(`Error: ${err.message}`);
        }

        // 等待一秒后再进行下一次发送
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}, 1000); // 等待 1 秒确保客户端连接成功


/*plc modbus 通讯， begin*/
// async function testModbusPLC() {
//     await modbusRTU_1.connectRTUBuffered(serial_port_addr_1, { baudRate: 115200, dataBits: 8, parity: 'even', stopBits: 1 });
//     console.log(`Connected to ${serial_port_addr_1}`);

//     // **创建多个 PLC 实例（共享同一个串口）**
//     const plc1 = new ModbusClient(modbusRTU_1, 11);
//     //const plc2 = new ModbusClient(modbusRTU_1, 2);

//     setInterval(async () => {
//         try {
//             //await plc1.readDiscreteInputs(8, 0x0800);
//             await plc1.readCoils(16, 0x092c); // 读取线圈
//             await plc1.writeCoils([true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false], 0x095e);
            
//         } catch (err) {
//             console.error("Modbus error:", err);
//         }

//         // 读取保持寄存器
//         //     plc1.readHoldingRegisters(0x1064, 2)
//         // .then(data => {
//         //     console.log("读取到的保持寄存器数据：", data);
//         // })
//         // .catch(err => {
//         //     console.error("读取保持寄存器出错：", err);
//         // });

//         // 写入多个寄存器
//         const values = [10, 20]; // 要写入的数值数组
//         plc1.writeRegisters(0x1064, values)
//         .then(() => {
//             console.log("写入寄存器成功");
//         })
//         .catch(err => {
//             console.error("写入寄存器出错：", err);
//         });
//     }, 1000);
// }

//testModbusPLC().catch(err => console.error("Connection Error:", err));
