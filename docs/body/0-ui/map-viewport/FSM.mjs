
let isMoving = false;

function initMap(el) {
  let startX, startY;

  el.onpointerdown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isMoving = false;
    [startX, startY] = [e.pageX, e.pageY];
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }

  function onMove(e) {
    const [dx, dy] = [e.pageX - startX, e.pageY - startY];
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isMoving = true;
    el.scrollLeft -= e.movementX;
    el.scrollTop -= e.movementY;
  }
}


class UiMapViewport extends HTMLElement {
  static #stylesInjected = false;
  constructor() {
    super();
  }
  connectedCallback() {
    if (!UiMapViewport.#stylesInjected) {
      // this.id = 'map-viewport';
      // this.classList.add('map-container');
      UiMapViewport.#stylesInjected = true;
      document.head.appendChild(Object.assign(document.createElement('style'), {
        textContent: `
        body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #202020;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        ui-map-viewport {
            display: block;
            width: 100vw;
            height: 100vh;
            overflow: auto;
            cursor: grab;
            -webkit-overflow-scrolling: touch;
            /* will-change: transform; */
        }

        ui-map-viewport:active {
            cursor: grabbing;
        }

        .map-content {
            position: relative;
            display: inline-block;
            line-height: 0;
        }

        .map-image {
            display: block;
            user-select: none;
            -webkit-user-drag: none;
            pointer-events: none;
        }
        ` }));
    }

    this.innerHTML = `
        <div class="map-content" role="presentation">
            <img src="https://placehold.jp/2000x2000.png" alt="Map" class="map-image">
        </div>
        `;

    //     <div style="position: absolute; top: 200px; left: 300px;">
    //         <div onclick="openModal('modal-shop')">Магазин</div>
    //     </div>
    //     <div style="position: absolute; top: 800px; left: 1200px;">
    //         <div onclick="openModal('modal-warehouse')">Склад</div>
    //     </div>
    //     <div style="position: fixed; top: 100px; left: 100px;">
    //         <div onclick="openModal('modal-warehouse')">Деньги</div>
    //     </div>
    //     <div style="position: fixed; bottom: 100px; left: 0px;">
    //         <div onclick="openModal('modal-warehouse')">Футер</div>
    //     </div>
    //     <div style="position: fixed; top: 100px; right: 100px;">
    //         <div onclick="openModal('modal-warehouse')">Aside</div>
    //     </div>
    // </div>

    // function openModal(id) {
    //   if (isMoving) return;
    //   if (modals[id]) {
    //     modals[id].open();
    //   }
    // }

    this.setAttribute('role', 'region');
    initMap(this);
  }
}

customElements.define('ui-map-viewport', UiMapViewport);

// Инициализация при загрузке модуля
document.body.append(new UiMapViewport());
