import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

export const EACH_CHUNK_SIZE = 1024 * 1024;
// 拆分后最小chunk请求大小 256kb
export const EACH_SMALL_CHUNK_SIZE = 256 * 1024;
// 初始数据长度
export const INITIAL_DATA_LENGTH = 10 * 1024;

export class RangeLoader extends PDFDataRangeTransport {
    constructor(length, initialData, pdfPath, eachChunkSize) {
        super(length, initialData);
        this.pdfPath = pdfPath;
        this.eachChunkSize = eachChunkSize;
    }

    async requestDataRange(start, end) {
        const realEnd = end - 1;
        // console.log(`[分片加载] [长度：${realEnd - start}] ${start} - ${realEnd}`);
        const groups = this.getBatchGroups(start, realEnd, this.getDynamicChunkSize());
        const datas = await Promise.all(
            groups.map(([eachStart, eachEnd]) => {
                const result = this.getDataByRangeLimit({ start: eachStart, end: eachEnd });
                return result;
            }));
        const byteLength = datas.reduce((total, data) => total + data.byteLength, 0);
        const byteData = new Uint8Array(byteLength);
        let offset = 0;
        for (const data of datas) {
            byteData.set(new Uint8Array(data), offset);
            offset += data.byteLength;
        }
        this.onDataProgress(byteData.byteLength, this.pdfSize);
        this.onDataRange(start, byteData);
    }

    getBatchGroups(start, end, limitLength) {
        const count = Math.ceil((end - start) / limitLength);
        return (new Array(count).fill(0)
            .map((_, index) => {
                const eachStart = index * limitLength + start;
                const eachEnd = Math.min(eachStart + limitLength - 1, end);
                return [eachStart, eachEnd];
            }));
    }

    getDynamicChunkSize() {
        return EACH_SMALL_CHUNK_SIZE;
    }

    async getDataByRangeLimit({ start, end, }) {
        // console.log(`[分片请求]${start} - ${end}`);
        return await fetch(this.pdfPath, {
            headers: {
                Range: `bytes=${start}-${end}`,
            },
        }).then(response => {
            return response.arrayBuffer();
        });
    }
}