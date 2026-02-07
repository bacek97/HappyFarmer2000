
// let isMoving = false;

// function initMap(el) {
//   let startX, startY;

//   el.onpointerdown = (e) => {
//     if (e.pointerType === 'mouse' && e.button !== 0) return;
//     isMoving = false;
//     [startX, startY] = [e.pageX, e.pageY];
//     window.addEventListener('pointermove', onMove);
//     window.addEventListener('pointerup', onUp);
//   };

//   function onUp() {
//     window.removeEventListener('pointermove', onMove);
//     window.removeEventListener('pointerup', onUp);
//   }

//   function onMove(e) {
//     const [dx, dy] = [e.pageX - startX, e.pageY - startY];
//     if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isMoving = true;
//     el.scrollLeft -= e.movementX;
//     el.scrollTop -= e.movementY;
//   }
// }


import { GameModal } from '../../0-ui/0-modal/FSM.mjs';

class PlotsPlot extends HTMLElement {
    static #stylesInjected = false;
    constructor() {
        super();
    }
    fsm = {
        mode: 'harvest',
        plant: undefined,
        startTime: 0,
        on: {
            pointerdown: () => {
                this.fsm.startTime = Date.now();
            },
            click: (txt) => {
                const duration = Date.now() - this.fsm.startTime;
                if (duration > 200) return; // Игнорируем длинное зажатие (перемещение)

                this.fsm.handle[this.fsm.mode](txt);
            }
        },
        handle: {
            harvest: (txt) => {
                console.log('harvest');

                this.classList.toggle('harvested');
            },
            plant: () => { console.log('plant'); },
            buy: () => { console.log('buy'); },

        }

    }
    // onclick = () => { console.log('test67'); }

    connectedCallback() {
        if (!PlotsPlot.#stylesInjected) {
            // this.id = 'map-viewport';
            // this.classList.add('map-container');
            PlotsPlot.#stylesInjected = true;
            document.head.appendChild(Object.assign(document.createElement('style'), {
                textContent: `

        ` }));
        }

        this.classList.add('harvested');

        // this.onclick = () => { console.log('test67'); };
        this.addEventListener('pointerdown', this.fsm.on.pointerdown);
        this.addEventListener('click', this.fsm.on.click);
        // this.id = 'field';
        // this.innerHTML = `
        //             <div onclick="openModal('modal-shop')">Магазин</div>
        //     `;
        // this.append(Object.assign(document.createElement('button'), {
        //     textContent: 'Juice',
        //     onclick: () => {
        //         modals['modal-shop'].open();
        //     }
        // }));
        // this.style.position = 'absolute';
        // this.style.top = '400px';
        // this.style.left = '300px';

        // function openModal(id) {
        //   if (isMoving) return;
        //   if (modals[id]) {
        //     modals[id].open();
        //   }
        // }

        // this.setAttribute('role', 'region');
        // initMap(this);



    }

}

customElements.define('plots-plot', PlotsPlot);


class FactoryPlots extends HTMLElement {
    static #stylesInjected = false;
    constructor() {
        super();
    }
    fsm = {
        assd: () => { console.log(this); }

    }

    connectedCallback() {
        if (!FactoryPlots.#stylesInjected) {
            // this.id = 'map-viewport';
            // this.classList.add('map-container');
            FactoryPlots.#stylesInjected = true;
            document.head.appendChild(Object.assign(document.createElement('style'), {
                textContent: `

        .game-container {
            position: relative;
            width: 100%;
            min-height: 120vh;
            display: flex;
            justify-content: center;
            padding-top: 80px;
        }

        .plot-container {
            position: relative;
            width: 540px;
        }

        .plot {
            position: absolute;
            width: 90px;
            height: 45px;
            /* Указываем, что события должны ловиться на этом слое */
            pointer-events: all;
        }

        .plot::before {
            content: "";
            position: absolute;
            inset: 0;
            background: #4caf50;
            clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
            z-index: 1;
            transition: background 0.2s;
        }

        .plot:hover::before {
            filter: brightness(1.15);
        }

        .plot.harvested::before {
            background: #6b4f2c;
        }

        .plot img {
            position: absolute;
            left: 50%;
            bottom: 35%;
            width: 60px;
            transform: translateX(-50%);
            z-index: 2;
            pointer-events: none;
            transition: all 0.3s ease;
        }

        .plot.harvested img {
            opacity: 0;
            transform: translateX(-50%) translateY(20px) scale(0);
        }

        ` }));
        }

        this.classList.add('plot-container');
        this.id = 'field';
        // this.innerHTML = `
        //             <div onclick="openModal('modal-shop')">Магазин</div>
        //     `;
        // this.append(Object.assign(document.createElement('button'), {
        //     textContent: 'Juice',
        //     onclick: () => {
        //         modals['modal-shop'].open();
        //     }
        // }));
        // this.style.position = 'absolute';
        // this.style.top = '400px';
        // this.style.left = '300px';

        // function openModal(id) {
        //   if (isMoving) return;
        //   if (modals[id]) {
        //     modals[id].open();
        //   }
        // }

        // this.setAttribute('role', 'region');
        // initMap(this);


        this.style.position = 'absolute';
        this.style.top = '400px';
        this.style.left = '300px';
        const field = this;

        // Настройки сетки
        const cols = 4, rows = 8;
        const W = 90, H = 45;
        const ox = (cols - 1) * (W / 2);

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const plot = document.createElement('plots-plot');
                plot.className = 'plot';
                plot.style.left = ox - (x - y) * (W / 2) + 'px';
                plot.style.top = (x + y) * (H / 2) + 'px';

                const img = document.createElement('img');
                img.src = 'fsm/animals/dog/dog2.webp';
                img.onerror = () => img.src = 'https://cdn-icons-png.flaticon.com/128/188/188333.png';

                plot.appendChild(img);
                field.appendChild(plot);

                // --- ИНДИВИДУАЛЬНЫЕ СОБЫТИЯ ДЛЯ ПЛАТФОРМ ---

                // Функция сбора для конкретной грядки
                // const harvest = () => {
                //     if (isSickleMode && !plot.classList.contains('harvested')) {
                //         plot.classList.add('harvested');
                //         if (navigator.vibrate) navigator.vibrate(15);
                //     }
                // };

                // 1. Для мыши (ПК) - работает мгновенно при наведении
                // plot.onmouseenter = harvest;

                // 2. Для тапа/клика
                // plot.onpointerdown = (e) => {
                //     if (!e.target.closest('.tool')) harvest();
                // };
            }
        }

    }

}

customElements.define('factory-plots', FactoryPlots);




// Инициализация при загрузке модуля
document.querySelector('.map-content').append(new FactoryPlots());
